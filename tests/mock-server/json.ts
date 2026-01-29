export function toJson(value: unknown, _replacer?: unknown, space?: number): string {
  return JSON.stringify(value, null, space);
}

export function fromJson(text: string): unknown {
  return JSON.parse(text);
}
