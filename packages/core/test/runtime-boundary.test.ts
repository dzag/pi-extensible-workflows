import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RuntimeAgentHandoff, RuntimeAgentProgress, RuntimeAgentRunControl, RuntimeAgentRunner, RuntimeJsonValue, RuntimeTool } from "../src/runtime/index.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/runtime");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

void test("the runtime boundary has no Pi SDK imports", () => {
  for (const path of sourceFiles(runtimeRoot)) assert.doesNotMatch(readFileSync(path, "utf8"), /@earendil-works\//, path);
});

void test("the runner contract carries tools, cancellation, usage, and handoff explicitly", async () => {
  let received: RuntimeJsonValue | undefined;
  const tool: RuntimeTool = {
    name: "echo",
    description: "Echo input",
    parameters: { type: "object" },
    async execute(call) {
      received = call.input;
      return { value: call.input };
    },
  };
  let transferred = false;
  const handoff: RuntimeAgentHandoff = {
    state: "local-running",
    get transferred() { return transferred; },
    observe: () => undefined,
    request: async (launch) => { await launch(); },
    waitForTakeover: async () => undefined,
    takeover: () => { transferred = true; },
    waitForResume: async () => undefined,
    release: () => undefined,
  };
  let receivedControl: RuntimeAgentRunControl | undefined;
  const runner: RuntimeAgentRunner = {
    id: "test",
    capabilities: { customTools: true, structuredResults: true, steering: true, handoff: true, usage: "complete" },
    async run(request) {
      assert.equal(request.customTools[0], tool);
      assert.equal(request.handoff, handoff);
      assert.equal(request.signal.aborted, false);
      await request.onControl?.({ handoff, steer: async () => undefined });
      await tool.execute({ id: "call-1", input: { ok: true }, signal: request.signal });
      return { value: received ?? null, usage: { availability: "complete", input: 1, output: 1, costUsd: 0 }, transport: "test" };
    },
  };
  const controller = new AbortController();
  const result = await runner.run({
    task: "test",
    cwd: process.cwd(),
    model: { provider: "test", model: "test" },
    enabledTools: ["echo"],
    customTools: [tool],
    run: { id: "run", namespaceId: "namespace", workflowName: "test" },
    agent: { id: "agent", structuralPath: ["agent"] },
    signal: controller.signal,
    handoff,
    onControl: (control) => { receivedControl = control; },
  });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.availability, "complete");
  assert.ok(receivedControl);
  assert.equal(receivedControl.handoff, handoff);
  handoff.observe({ type: "turn-ended" });
  const opening = handoff.request(async () => { handoff.takeover(); });
  await handoff.waitForTakeover();
  await opening;
  await handoff.waitForResume();
  assert.equal(handoff.transferred, true);
  handoff.release("test complete");
});

void test("progress preserves live tool and model state", () => {
  const progress: RuntimeAgentProgress = {
    usage: { availability: "partial", input: 1 },
    toolCalls: [{ id: "call-1", name: "echo", state: "running" }],
    state: { model: { provider: "test", model: "test" }, tools: ["echo"] },
    persist: true,
  };
  assert.equal(progress.toolCalls[0]?.name, "echo");
  assert.equal(progress.state?.tools[0], "echo");
});
