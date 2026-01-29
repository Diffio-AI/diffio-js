import { Supplier, type Supplier as SupplierType } from "./supplier";

export type HeaderValue = string | SupplierType<string | null | undefined> | null | undefined;
export type HeaderRecord = Record<string, HeaderValue>;

export function mergeHeaders(...sets: Array<HeaderRecord | null | undefined>): HeaderRecord {
  const result: HeaderRecord = {};
  for (const set of sets) {
    if (!set) {
      continue;
    }
    for (const [key, value] of Object.entries(set)) {
      result[key] = value;
    }
  }
  return result;
}

export function mergeOnlyDefinedHeaders(headers: HeaderRecord): HeaderRecord {
  const result: HeaderRecord = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export async function resolveHeaders(headers: HeaderRecord | null | undefined): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  if (!headers) {
    return resolved;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }
    const resolvedValue = await Supplier.get(value);
    if (resolvedValue == null) {
      continue;
    }
    resolved[key] = resolvedValue;
  }
  return resolved;
}
