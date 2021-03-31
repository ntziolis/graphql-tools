interface Settler<T> {
  resolve(value: T): void;
  reject(reason?: any): void;
}

export class ExpectantStore<T> {
  protected settlers: Record<string, Set<Settler<T>>> = {};
  protected cache: Record<string, T> = {};

  set(key: string, value: T): void {
    this.cache[key] = value;
    const settlers = this.settlers[key];
    if (settlers != null) {
      for (const { resolve } of settlers) {
        resolve(value);
      }
      settlers.clear();
      delete this.settlers[key];
    }
  }

  get(key: string): T {
    return this.cache[key];
  }

  request(key: string): Promise<T> | T {
    const value = this.cache[key];

    if (value !== undefined) {
      return value;
    }

    let settlers = this.settlers[key];
    if (settlers != null) {
      settlers = this.settlers[key] = new Set();
    }

    return new Promise((resolve, reject) => {
      settlers.add({ resolve, reject });
    });
  }

  clear(reason?: any): void {
    for (const settlers of Object.values(this.settlers)) {
      for (const { reject } of settlers) {
        reject(reason);
      }
    }

    this.settlers = {};
    this.cache = {};
  }
}
