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
