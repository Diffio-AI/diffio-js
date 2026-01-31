#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const pkgPath = path.join(rootDir, "package.json");
const lockPath = path.join(rootDir, "package-lock.json");
const versionPath = path.join(rootDir, "src", "version.ts");

const bumpArg = process.argv[2] || process.env.BUMP || "patch";

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();

const snapshots = new Map();
const record = (filePath) => {
  if (fs.existsSync(filePath)) {
    snapshots.set(filePath, fs.readFileSync(filePath, "utf8"));
  }
};

const restore = () => {
  for (const [filePath, contents] of snapshots.entries()) {
    fs.writeFileSync(filePath, contents, "utf8");
  }
  for (const filePath of [pkgPath, lockPath, versionPath]) {
    if (!snapshots.has(filePath) && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
};

record(pkgPath);
record(lockPath);
record(versionPath);

try {
  run("node", [path.join(rootDir, "scripts", "bump-version.mjs"), bumpArg], {
    cwd: rootDir,
    stdio: "inherit",
  });
  run("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" });
  run("npm", ["publish", "--ignore-scripts"], { cwd: rootDir, stdio: "inherit" });
} finally {
  restore();
}
