import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { beginWorkflowExtensionLoading, loadingRegistry, registeredWorkflowFunctions, registeredWorkflowRoleDirectoryRegistrations, workflowCatalog } from "pi-extensible-workflows";

test("registers the function, packaged role, and opt-in advanced pieces", async () => {
  const { default: extension } = await import("./extension.mjs");
  beginWorkflowExtensionLoading();
  extension();

  const catalog = workflowCatalog();
  assert.deepEqual(catalog.functions.map(({ name }) => name), ["greet"]);
  assert.deepEqual(catalog.modelAliasEntries?.filter(({ name }) => name === "template-model").map(({ name, kind }) => ({ name, kind })), [{ name: "template-model", kind: "dynamic" }]);
  assert.equal(await registeredWorkflowFunctions().greet.run({ name: "Ada" }, {}), "Hello, Ada!");

  const registration = registeredWorkflowRoleDirectoryRegistrations()[0];
  assert.ok(registration);
  assert.match(readFileSync(join(registration.path, "reviewer.md"), "utf8"), /Packaged reviewer role/);

  const resolved = await loadingRegistry().resolveModelAliases({
    cwd: process.cwd(),
    projectTrusted: true,
    rootModel: { provider: "example", model: "root" },
    knownModels: new Set(["example/root", "example/available"]),
    availableModels: new Set(["example/available"]),
    signal: new AbortController().signal,
  });
  assert.deepEqual(resolved, { "template-model": "example/available" });

  const hook = loadingRegistry().agentSetupHooks().find(({ name }) => name === "templateAdvisor");
  assert.ok(hook);
  const agent = { prompt: "Review this", options: {}, sessionInput: {} };
  await hook.setup(agent, { signal: new AbortController().signal });
  assert.equal(agent.sessionInput.systemPromptAppend, undefined);
  agent.options.templateAdvisor = true;
  await hook.setup(agent, { signal: new AbortController().signal });
  assert.match(agent.sessionInput.systemPromptAppend, /one concrete risk/);
});
