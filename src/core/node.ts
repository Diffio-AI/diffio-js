/** True in Node (not in browsers, even with a `process` shim). */
export const isNode = (): boolean =>
  typeof process !== "undefined" && Boolean((process as { versions?: { node?: string } }).versions?.node) &&
  typeof (globalThis as { window?: unknown }).window === "undefined";

/**
 * Loads a Node built-in. The id is a variable so browser bundlers do not try to bundle Node modules; the
 * SDK only calls this on Node code paths (file paths, node:crypto).
 */
export function nodeRequire<T>(id: string): T | undefined {
  if (!isNode() || typeof require !== "function") return undefined;
  return require(id) as T;
}
