import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(coreRoot, "../..");
const readPackage = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the repository keeps the public package in the core workspace", () => {
  const root = readPackage(resolve(repositoryRoot, "package.json"));
  const core = readPackage(resolve(coreRoot, "package.json"));

  assert.equal(root.private, true);
  assert.deepEqual(root.workspaces, ["packages/core", "packages/extensions/*"]);
  assert.deepEqual(root.pi.extensions, ["./packages/core/src/index.ts"]);
  assert.equal(core.name, "pi-extensible-workflows");
  assert.equal(core.version, root.version);
  assert.notEqual(core.private, true);
  assert.equal(core.exports, "./dist/src/index.js");
  assert.equal(core.bin["pi-extensible-workflows"], "./dist/src/cli.js");
  assert.equal(core.publishConfig.access, "public");
});
