#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const pkgPath = path.join(rootDir, "package.json");
const versionPath = path.join(rootDir, "src", "version.ts");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const bump = (process.argv[2] || process.env.BUMP || "patch").toLowerCase();
if (!["major", "minor", "patch"].includes(bump)) {
  console.error("Usage: node scripts/bump-version.mjs [major|minor|patch]");
  process.exit(1);
}

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();

let registry = process.env.NPM_REGISTRY;
if (!registry) {
  try {
    registry = run("npm", ["config", "get", "registry"]);
  } catch {
    registry = "https://registry.npmjs.org/";
  }
}
if (!registry || registry === "undefined" || registry === "null") {
  registry = "https://registry.npmjs.org/";
}

let latest = "0.0.0";
try {
  const out = run("npm", ["view", pkg.name, "version", "--json", "--registry", registry]);
  const parsed = JSON.parse(out);
  if (typeof parsed === "string") {
    latest = parsed;
  }
} catch {
  console.warn(`No published version found for ${pkg.name}; starting from ${latest}.`);
}

const parts = latest.split(".");
if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
  throw new Error(`Unsupported version format from registry: ${latest}`);
}

let [major, minor, patch] = parts.map((part) => Number(part));
if (bump === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bump === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const next = `${major}.${minor}.${patch}`;
run("npm", ["version", "--no-git-tag-version", next], { cwd: rootDir, stdio: "inherit" });
fs.writeFileSync(versionPath, `export const DIFFIO_SDK_VERSION = "${next}";\n`, "utf8");

console.log(`Bumped ${pkg.name} from ${latest} to ${next} (registry: ${registry}).`);
