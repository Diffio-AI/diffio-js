import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIFFIO_SDK_VERSION } from "../../../src/version";

describe("SDK version", () => {
  test("matches package.json and package-lock.json", () => {
    const root = join(__dirname, "..", "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };

    expect(DIFFIO_SDK_VERSION).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.version).toBe(pkg.version);
  });
});
