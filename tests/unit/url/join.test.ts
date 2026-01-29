import { join } from "../../../src/core/url";

describe("join", () => {
  test("returns base when no segments are provided", () => {
    expect(join("base")).toBe("base");
    expect(join("base/")).toBe("base");
  });

  test("joins segments with single slashes", () => {
    expect(join("base", "path")).toBe("base/path");
    expect(join("base/", "/path/")).toBe("base/path/");
  });

  test("skips empty segments", () => {
    expect(join("base", "", "path")).toBe("base/path");
    expect(join("base", "/", "path")).toBe("base/path");
  });

  test("handles multiple segments", () => {
    expect(join("base", "one", "two")).toBe("base/one/two");
  });
});
