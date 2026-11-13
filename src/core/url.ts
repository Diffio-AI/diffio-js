export function join(base: string, ...paths: string[]): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPaths = paths
    .filter(Boolean)
    .map((part) => part.replace(/^\/+/, ""))
    .filter((part) => part.length > 0);
  if (trimmedPaths.length === 0) {
    return trimmedBase;
  }
  return [trimmedBase, ...trimmedPaths].join("/");
}

export const DEFAULT_BASE_URL = "https://api.diffio.ai";
const API_VERSION_PREFIX = "v2";

/**
 * Turns a host (`https://api.diffio.ai`) or a versioned base (`.../v2`) into the v2 base URL.
 * A base ending in `/v1` (the old SDK's documented value) is moved to `/v2`.
 */
export function resolveApiBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith(`/${API_VERSION_PREFIX}`)) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed.slice(0, -3)}/${API_VERSION_PREFIX}`;
  return `${trimmed}/${API_VERSION_PREFIX}`;
}

/** Encodes one path segment (a project, generation, export, turn or share id). */
export function segment(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return encodeURIComponent(value);
}

/** Builds `?a=1&b=2` from defined, non-null values; empty when there are none. */
export function queryString(params?: Record<string, string | number | boolean | null | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
