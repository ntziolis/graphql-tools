import {
  FieldNode,
  GraphQLObjectType,
  GraphQLResolveInfo,
  Kind,
  SelectionSetNode,
  responsePathAsArray,
  getNamedType,
  GraphQLSchema,
  print,
  GraphQLFieldMap,
} from 'graphql';

import isPromise from 'is-promise';

import DataLoader from 'dataloader';

import { collectFields, getResponseKeyFromInfo, GraphQLExecutionContext } from '@graphql-tools/utils';

import { ExternalObject, MergedTypeInfo, StitchingInfo } from './types';
import { getInfo, getSubschema, mergeExternalObjects } from './externalObjects';
import { memoize4, memoize3, memoize2 } from './memoize';
import { Subschema } from './Subschema';

const loaders: WeakMap<any, DataLoader<GraphQLResolveInfo, Promise<ExternalObject>>> = new WeakMap();

export async function getMergedParent(
  parent: ExternalObject,
  context: Record<string, any>,
  info: GraphQLResolveInfo
): Promise<ExternalObject> {
  let loader = loaders.get(parent);
  if (loader === undefined) {
    loader = new DataLoader(infos => getMergedParentsFromInfos(parent, context, infos));
    loaders.set(parent, loader);
  }
  return loader.load(info);
}

async function getMergedParentsFromInfos(
  parent: ExternalObject,
  context: Record<string, any>,
  infos: ReadonlyArray<GraphQLResolveInfo>
): Promise<Array<Promise<ExternalObject>>> {
  const parentInfo = getInfo(parent);

  const schema = parentInfo.schema;
  const stitchingInfo: StitchingInfo = schema.extensions?.stitchingInfo;
  const parentTypeName = infos[0].parentType.name;
  const mergedTypeInfo = stitchingInfo?.mergedTypes[parentTypeName];
  if (mergedTypeInfo === undefined) {
    return infos.map(() => Promise.resolve(parent));
  }

  // In the stitching context, all subschemas are compiled Subschema objects rather than SubschemaConfig objects
  const sourceSubschema = getSubschema(parent) as Subschema;
  const targetSubschemas = mergedTypeInfo.targetSubschemas.get(sourceSubschema);
  if (targetSubschemas === undefined || targetSubschemas.length === 0) {
    return infos.map(() => Promise.resolve(parent));
  }

  const sourceSubschemaParentType = sourceSubschema.transformedSchema.getType(parentTypeName) as GraphQLObjectType;
  const sourceSubschemaFields = sourceSubschemaParentType.getFields();

  let fieldNodes: Array<FieldNode> = [].concat(...infos.map(info => info.fieldNodes));

  const keyFieldNodes: Map<string, FieldNode> = new Map();

  const parentType = schema.getType(parentTypeName) as GraphQLObjectType;

  const fieldSelectionSets = stitchingInfo?.selectionSetsByField?.[parentTypeName];
  infos.forEach(info => {
    const fieldName = info.fieldName;
    const fieldSelectionSet = fieldSelectionSets[fieldName];
    if (fieldSelectionSet !== undefined) {
      addSelectionSetToMap(keyFieldNodes, schema, parentType, sourceSubschemaFields, fieldSelectionSet);
    }
  });

  fieldNodes = fieldNodes.concat(...Array.from(keyFieldNodes.values()));

  const mergedParents = getMergedParentsFromFieldNodes(
    mergedTypeInfo,
    parent,
    fieldNodes,
    sourceSubschema,
    targetSubschemas,
    context,
    parentInfo
  );

  return infos.map(info => mergedParents[getResponseKeyFromInfo(info)]);
}

function getMergedParentsFromFieldNodes(
  mergedTypeInfo: MergedTypeInfo,
  object: any,
  fieldNodes: Array<FieldNode>,
  sourceSubschemaOrSourceSubschemas: Subschema | Array<Subschema>,
  targetSubschemas: Array<Subschema>,
  context: Record<string, any>,
  info: GraphQLResolveInfo
): Record<string, Promise<ExternalObject>> {
  if (!fieldNodes.length) {
    return Object.create(null);
  }

  const { proxiableSubschemas, nonProxiableSubschemas } = sortSubschemasByProxiability(
    mergedTypeInfo,
    sourceSubschemaOrSourceSubschemas,
    targetSubschemas,
    fieldNodes
  );

  const { delegationMap, unproxiableFieldNodes } = buildDelegationPlan(mergedTypeInfo, fieldNodes, proxiableSubschemas);

  if (!delegationMap.size) {
    const mergedParentMap = Object.create(null);
    unproxiableFieldNodes.forEach(fieldNode => {
      const responseKey = fieldNode.alias?.value ?? fieldNode.name.value;
      mergedParentMap[responseKey] = Promise.resolve(object);
    });
    return mergedParentMap;
  }

  const resultMap: Map<Promise<any> | any, SelectionSetNode> = new Map();

  const mergedParentMap = Object.create(null);
  delegationMap.forEach((fieldNodes: Array<FieldNode>, s: Subschema) => {
    const resolver = mergedTypeInfo.resolvers.get(s);
    const selectionSet = { kind: Kind.SELECTION_SET, selections: fieldNodes };
    let maybePromise = resolver(object, context, info, s, selectionSet);
    if (isPromise(maybePromise)) {
      maybePromise = maybePromise.then(undefined, error => error);
    }
    resultMap.set(maybePromise, selectionSet);

    const promise = Promise.resolve(maybePromise).then(result =>
      mergeExternalObjects(
        info.schema,
        responsePathAsArray(info.path),
        object.__typename,
        object,
        [result],
        [selectionSet]
      )
    );

    fieldNodes.forEach(fieldNode => {
      const responseKey = fieldNode.alias?.value ?? fieldNode.name.value;
      mergedParentMap[responseKey] = promise;
    });
  });

  const nextPromise = Promise.all(resultMap.keys())
    .then(results =>
      mergeExternalObjects(
        info.schema,
        responsePathAsArray(info.path),
        object.__typename,
        object,
        results,
        Array.from(resultMap.values())
      )
    )
    .then(mergedParent =>
      getMergedParentsFromFieldNodes(
        mergedTypeInfo,
        mergedParent,
        unproxiableFieldNodes,
        combineSubschemas(sourceSubschemaOrSourceSubschemas, proxiableSubschemas),
        nonProxiableSubschemas,
        context,
        info
      )
    );

  unproxiableFieldNodes.forEach(fieldNode => {
    const responseKey = fieldNode.alias?.value ?? fieldNode.name.value;
    mergedParentMap[responseKey] = nextPromise.then(nextParent => nextParent[responseKey]);
  });

  return mergedParentMap;
}

const sortSubschemasByProxiability = memoize4(function (
  mergedTypeInfo: MergedTypeInfo,
  sourceSubschemaOrSourceSubschemas: Subschema | Array<Subschema>,
  targetSubschemas: Array<Subschema>,
  fieldNodes: Array<FieldNode>
): {
  proxiableSubschemas: Array<Subschema>;
  nonProxiableSubschemas: Array<Subschema>;
} {
  // 1.  calculate if possible to delegate to given subschema

  const proxiableSubschemas: Array<Subschema> = [];
  const nonProxiableSubschemas: Array<Subschema> = [];

  targetSubschemas.forEach(t => {
    const selectionSet = mergedTypeInfo.selectionSets.get(t);
    const fieldSelectionSets = mergedTypeInfo.fieldSelectionSets.get(t);
    if (
      selectionSet != null &&
      !subschemaTypesContainSelectionSet(mergedTypeInfo, sourceSubschemaOrSourceSubschemas, selectionSet)
    ) {
      nonProxiableSubschemas.push(t);
    } else {
      if (
        fieldSelectionSets == null ||
        fieldNodes.every(fieldNode => {
          const fieldName = fieldNode.name.value;
          const fieldSelectionSet = fieldSelectionSets[fieldName];
          return (
            fieldSelectionSet == null ||
            subschemaTypesContainSelectionSet(mergedTypeInfo, sourceSubschemaOrSourceSubschemas, fieldSelectionSet)
          );
        })
      ) {
        proxiableSubschemas.push(t);
      } else {
        nonProxiableSubschemas.push(t);
      }
    }
  });

  return {
    proxiableSubschemas,
    nonProxiableSubschemas,
  };
});

const buildDelegationPlan = memoize3(function (
  mergedTypeInfo: MergedTypeInfo,
  fieldNodes: Array<FieldNode>,
  proxiableSubschemas: Array<Subschema>
): {
  delegationMap: Map<Subschema, Array<FieldNode>>;
  unproxiableFieldNodes: Array<FieldNode>;
} {
  const { uniqueFields, nonUniqueFields } = mergedTypeInfo;
  const unproxiableFieldNodes: Array<FieldNode> = [];

  // 2. for each selection:

  const delegationMap: Map<Subschema, Array<FieldNode>> = new Map();
  fieldNodes.forEach(fieldNode => {
    if (fieldNode.name.value === '__typename') {
      return;
    }

    // 2a. use uniqueFields map to assign fields to subschema if one of possible subschemas

    const uniqueSubschema: Subschema = uniqueFields[fieldNode.name.value];
    if (uniqueSubschema != null) {
      if (!proxiableSubschemas.includes(uniqueSubschema)) {
        unproxiableFieldNodes.push(fieldNode);
        return;
      }

      const existingSubschema = delegationMap.get(uniqueSubschema);
      if (existingSubschema != null) {
        existingSubschema.push(fieldNode);
      } else {
        delegationMap.set(uniqueSubschema, [fieldNode]);
      }

      return;
    }

    // 2b. use nonUniqueFields to assign to a possible subschema,
    //     preferring one of the subschemas already targets of delegation

    let nonUniqueSubschemas: Array<Subschema> = nonUniqueFields[fieldNode.name.value];
    if (nonUniqueSubschemas == null) {
      unproxiableFieldNodes.push(fieldNode);
      return;
    }

    nonUniqueSubschemas = nonUniqueSubschemas.filter(s => proxiableSubschemas.includes(s));
    if (!nonUniqueSubschemas.length) {
      unproxiableFieldNodes.push(fieldNode);
      return;
    }

    const existingSubschema = nonUniqueSubschemas.find(s => delegationMap.has(s));
    if (existingSubschema != null) {
      delegationMap.get(existingSubschema).push(fieldNode);
    } else {
      delegationMap.set(nonUniqueSubschemas[0], [fieldNode]);
    }
  });

  return {
    delegationMap,
    unproxiableFieldNodes,
  };
});

const combineSubschemas = memoize2(function (
  subschemaOrSubschemas: Subschema | Array<Subschema>,
  additionalSubschemas: Array<Subschema>
): Array<Subschema> {
  return Array.isArray(subschemaOrSubschemas)
    ? subschemaOrSubschemas.concat(additionalSubschemas)
    : [subschemaOrSubschemas].concat(additionalSubschemas);
});

const subschemaTypesContainSelectionSet = memoize3(function (
  mergedTypeInfo: MergedTypeInfo,
  sourceSubschemaOrSourceSubschemas: Subschema | Array<Subschema>,
  selectionSet: SelectionSetNode
) {
  if (Array.isArray(sourceSubschemaOrSourceSubschemas)) {
    return typesContainSelectionSet(
      sourceSubschemaOrSourceSubschemas.map(
        sourceSubschema => sourceSubschema.transformedSchema.getType(mergedTypeInfo.typeName) as GraphQLObjectType
      ),
      selectionSet
    );
  }

  return typesContainSelectionSet(
    [sourceSubschemaOrSourceSubschemas.transformedSchema.getType(mergedTypeInfo.typeName) as GraphQLObjectType],
    selectionSet
  );
});

function typesContainSelectionSet(types: Array<GraphQLObjectType>, selectionSet: SelectionSetNode): boolean {
  const fieldMaps = types.map(type => type.getFields());

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fields = fieldMaps.map(fieldMap => fieldMap[selection.name.value]).filter(field => field != null);
      if (!fields.length) {
        return false;
      }

      if (selection.selectionSet != null) {
        return typesContainSelectionSet(
          fields.map(field => getNamedType(field.type)) as Array<GraphQLObjectType>,
          selection.selectionSet
        );
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT && selection.typeCondition.name.value === types[0].name) {
      return typesContainSelectionSet(types, selection.selectionSet);
    }
  }

  return true;
}

function addSelectionSetToMap(
  map: Map<string, FieldNode>,
  schema: GraphQLSchema,
  type: GraphQLObjectType,
  fields: GraphQLFieldMap<any, any>,
  selectionSet: SelectionSetNode
): void {
  const partialExecutionContext = ({
    schema,
    variableValues: Object.create(null),
    fragments: Object.create(null),
  } as unknown) as GraphQLExecutionContext;
  const responseKeys = collectFields(
    partialExecutionContext,
    type,
    selectionSet,
    Object.create(null),
    Object.create(null)
  );

  Object.values(responseKeys).forEach(fieldNodes => {
    const fieldName = fieldNodes[0].name.value;
    if (!(fieldName in fields)) {
      fieldNodes.forEach(fieldNode => {
        const key = print(fieldNode);
        if (!map.has(key)) {
          map.set(key, fieldNode);
        }
      });
    }
  });
}
