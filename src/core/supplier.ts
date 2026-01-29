export type Supplier<T> = T | (() => T | Promise<T>);

export const Supplier = {
  async get<T>(value: Supplier<T> | null | undefined): Promise<T | undefined> {
    if (value == null) {
      return undefined;
    }
    if (typeof value === "function") {
      return (value as () => T | Promise<T>)();
    }
    return value as T;
  }
};
