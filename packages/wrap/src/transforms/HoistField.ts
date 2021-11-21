import { defaultMergedResolver, DelegationContext, SubschemaConfig, Transform } from '@graphql-tools/delegate';
import {
  appendObjectFields,
  ExecutionRequest,
  ExecutionResult,
  relocatedError,
  removeObjectFields,
} from '@graphql-tools/utils';
import {
  FieldNode,
  getNullableType,
  GraphQLArgument,
  GraphQLError,
  GraphQLFieldResolver,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  isListType,
  isNonNullType,
  Kind,
  OperationTypeNode,
} from 'graphql';

import { defaultCreateProxyingResolver } from '../generateProxyingResolvers';
import MapFields from './MapFields';

export default class HoistField implements Transform {
  private readonly typeName: string;
  private readonly newFieldName: string;
  private readonly pathToField: Array<string>;
  private readonly oldFieldName: string;
  private readonly argFilters: Array<(arg: GraphQLArgument) => boolean>;
  private readonly argLevels: Record<string, number>;
  private readonly transformer: MapFields<any>;

  constructor(
    typeName: string,
    pathConfig: Array<string | { fieldName: string; argFilter?: (arg: GraphQLArgument) => boolean }>,
    newFieldName: string,
    alias = '__gqtlw__'
  ) {
    this.typeName = typeName;
    this.newFieldName = newFieldName;

    const path = pathConfig.map(segment => (typeof segment === 'string' ? segment : segment.fieldName));
    this.argFilters = pathConfig.map((segment, index) => {
      if (typeof segment === 'string' || segment.argFilter == null) {
        return index === pathConfig.length - 1 ? () => true : () => false;
      }
      return segment.argFilter;
    });

    const pathToField = path.slice();
    const oldFieldName = pathToField.pop();

    if (oldFieldName == null) {
      throw new Error(`Cannot hoist field to ${newFieldName} on type ${typeName}, no path provided.`);
    }

    this.oldFieldName = oldFieldName;
    this.pathToField = pathToField;
    const argLevels = Object.create(null);
    this.transformer = new MapFields(
      {
        [typeName]: {
          [newFieldName]: fieldNode =>
            this.wrapFieldNode(renameFieldNode(fieldNode, oldFieldName), pathToField, alias, argLevels),
        },
      },
      {
        [typeName]: value => unwrapValue(value, alias, newFieldName),
      },
      errors => (errors != null ? unwrapErrors(errors, alias) : undefined)
    );
    this.argLevels = argLevels;
  }

  public transformSchema(
    originalWrappingSchema: GraphQLSchema,
    subschemaConfig: SubschemaConfig,
    transformedSchema?: GraphQLSchema
  ): GraphQLSchema {
    const argsMap: Record<string, GraphQLArgument> = Object.create(null);
    const listWrapFns: ((type: GraphQLOutputType) => GraphQLOutputType)[] = [];
    const innerType: GraphQLObjectType = this.pathToField.reduce((acc, pathSegment, index) => {
      const field = acc.getFields()[pathSegment];
      for (const arg of field.args) {
        if (this.argFilters[index](arg)) {
          argsMap[arg.name] = arg;
          this.argLevels[arg.name] = index;
        }
      }

      if (isListType(field.type)) {
        listWrapFns.push(type => new GraphQLList(type));
        return getNullableType(field.type.ofType) as GraphQLObjectType;
      }

      if (isNonNullType(field.type) && isListType(field.type.ofType)) {
        listWrapFns.push(type => new GraphQLNonNull(new GraphQLList(type)));
        return getNullableType(field.type.ofType.ofType) as GraphQLObjectType;
      }

      return getNullableType(field.type) as GraphQLObjectType;
    }, originalWrappingSchema.getType(this.typeName) as GraphQLObjectType);

    let [newSchema, targetFieldConfigMap] = removeObjectFields(
      originalWrappingSchema,
      innerType.name,
      fieldName => fieldName === this.oldFieldName
    );

    const targetField = targetFieldConfigMap[this.oldFieldName];

    let resolve: GraphQLFieldResolver<any, any>;
    if (transformedSchema) {
      const hoistingToRootField =
        this.typeName === originalWrappingSchema.getQueryType()?.name ||
        this.typeName === originalWrappingSchema.getMutationType()?.name;

      if (hoistingToRootField) {
        const targetSchema = subschemaConfig.schema;
        const operation = this.typeName === targetSchema.getQueryType()?.name ? 'query' : 'mutation';
        const createProxyingResolver = subschemaConfig.createProxyingResolver ?? defaultCreateProxyingResolver;
        resolve = createProxyingResolver({
          subschemaConfig,
          transformedSchema,
          operation: operation as OperationTypeNode,
          fieldName: this.newFieldName,
        });
      } else {
        resolve = defaultMergedResolver;
      }
    }

    const newTargetField = listWrapFns.reduceRight(
      (acc, wrapFn) => {
        return {
          ...acc,
          type: wrapFn(acc.type),
        };
      },
      {
        ...targetField,
        resolve: resolve!,
      }
    );

    const level = this.pathToField.length;

    const args = targetField.args;
    if (args != null) {
      for (const argName in args) {
        const argConfig = args[argName];
        if (argConfig == null) {
          continue;
        }
        const arg = {
          ...argConfig,
          name: argName,
          description: argConfig.description,
          defaultValue: argConfig.defaultValue,
          extensions: argConfig.extensions,
          astNode: argConfig.astNode,
        } as GraphQLArgument;
        if (this.argFilters[level](arg)) {
          argsMap[argName] = arg;
          this.argLevels[arg.name] = level;
        }
      }
    }

    newTargetField.args = argsMap;

    newSchema = appendObjectFields(newSchema, this.typeName, {
      [this.newFieldName]: newTargetField,
    });

    return this.transformer.transformSchema(newSchema, subschemaConfig, transformedSchema);
  }

  public transformRequest(
    originalRequest: ExecutionRequest,
    delegationContext: DelegationContext,
    transformationContext: Record<string, any>
  ): ExecutionRequest {
    return this.transformer.transformRequest(originalRequest, delegationContext, transformationContext);
  }

  public transformResult(
    originalResult: ExecutionResult,
    delegationContext: DelegationContext,
    transformationContext: Record<string, any>
  ): ExecutionResult {
    return this.transformer.transformResult(originalResult, delegationContext, transformationContext);
  }

  private wrapFieldNode(fieldNode: FieldNode, path: Array<string>, alias: string, argLevels: Record<string, number>) {
    return wrapFieldNode(fieldNode, path, alias, argLevels);
  }
}

export function wrapFieldNode(
  fieldNode: FieldNode,
  path: Array<string>,
  alias: string,
  argLevels: Record<string, number>
): FieldNode {
  const wrappedFieldNode: FieldNode = path.reduceRight(
    (acc, fieldName, index) => {
      return {
        kind: Kind.FIELD,
        alias: {
          kind: Kind.NAME,
          value: alias,
        },
        name: {
          kind: Kind.NAME,
          value: fieldName,
        },
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [acc],
        },
        arguments:
          fieldNode.arguments != null
            ? fieldNode.arguments.filter(arg => argLevels[arg.name.value] === index)
            : undefined,
      };
    },
    {
      ...fieldNode,
      arguments:
        fieldNode.arguments != null
          ? fieldNode.arguments.filter(arg => argLevels[arg.name.value] === path.length)
          : undefined,
    }
  );

  return wrappedFieldNode;
}

export function renameFieldNode(fieldNode: FieldNode, name: string): FieldNode {
  return {
    ...fieldNode,
    alias: {
      kind: Kind.NAME,
      value: fieldNode.alias?.value || fieldNode.name.value,
    },
    name: {
      kind: Kind.NAME,
      value: name,
    },
  };
}

export function unwrapValue(originalValue: any, alias: string, fieldName: string): any {
  let newValue = originalValue;

  let object = newValue[alias];

  if (Array.isArray(object)) {
    newValue = {
      [fieldName]: object.map(item => {
        let newValueItem = item;
        while (item != null) {
          newValueItem = item;
          item = newValueItem[alias];
        }

        newValueItem = newValueItem[fieldName];

        return newValueItem;
      }),
    };
  } else {
    while (object != null) {
      newValue = object;
      object = newValue[alias];
    }
  }

  delete originalValue[alias];
  Object.assign(originalValue, newValue);

  return originalValue;
}

function unwrapErrors(errors: ReadonlyArray<GraphQLError> | undefined, alias: string): Array<GraphQLError> | undefined {
  if (errors === undefined) {
    return undefined;
  }

  return errors.map(error => {
    const originalPath = error.path;
    if (originalPath == null) {
      return error;
    }

    const newPath = originalPath.filter(pathSegment => pathSegment !== alias);

    return relocatedError(error, newPath);
  });
}
