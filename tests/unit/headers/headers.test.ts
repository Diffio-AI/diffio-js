import { mergeHeaders, mergeOnlyDefinedHeaders, resolveHeaders } from "../../../src/core/headers";

describe("headers helpers", () => {
  test("mergeHeaders combines and overrides in order", () => {
    const result = mergeHeaders({ Authorization: "a", "X-Test": "1" }, { Authorization: "b" });
    expect(result).toEqual({ Authorization: "b", "X-Test": "1" });
  });

  test("mergeOnlyDefinedHeaders keeps null and removes undefined", () => {
    const result = mergeOnlyDefinedHeaders({
      Authorization: "token",
      "X-Remove": undefined,
      "X-Null": null
    });
    expect(result).toEqual({ Authorization: "token", "X-Null": null });
  });

  test("resolveHeaders resolves suppliers and skips null values", async () => {
    const result = await resolveHeaders({
      Authorization: "token",
      "X-Sync": () => "sync-value",
      "X-Async": async () => "async-value",
      "X-Null": null,
      "X-Undefined": undefined,
      "X-Skip": () => null
    });
    expect(result).toEqual({
      Authorization: "token",
      "X-Sync": "sync-value",
      "X-Async": "async-value"
    });
  });
});
