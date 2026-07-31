import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_COMPLETED_EVENT } from "../src/index.js";
import type { PersistedRun } from "../src/persistence.js";
import type { RunState } from "../src/types.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

void test("parameterless /workflow resume selects an eligible run and execution mode", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-picker-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "interrupted-run", home);
  await store.create({ id: "interrupted-run", workflowName: "resume-picker", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return 'resumed';", args: null, metadata: { name: "resume-picker" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));

  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const selections: string[][] = [];
  const notices: string[] = [];
  workflowExtension({
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = options.handler; },
    registerTool() {},
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  } as never, home);
  const context = {
    cwd,
    hasUI: true,
    model: { provider: "openai", id: "gpt" },
    sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); },
      select: async (_prompt: string, options: string[]) => {
        selections.push(options);
        if (options.includes("Skip")) return "Skip";
        if (options.some((option) => option.includes("resume-picker"))) return options.find((option) => option.includes("resume-picker"));
        return "Foreground";
      },
    },
  };
  assert.ok(start && command);
  await start({}, context);
  await command("resume", context);
  assert.deepEqual(selections.at(-1), ["Foreground", "Background", "Cancel"]);
  assert.equal((await store.load()).run.state, "completed");
  assert.ok(notices.some((message) => message.includes('resume-picker') && message.includes('completed') && message.includes('"resumed"')));
});

type TestTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type TestSetup = { start: ((event: unknown, context: unknown) => Promise<void>) | undefined; shutdown: (() => Promise<void>) | undefined; command: (args: string, context: unknown) => Promise<void>; context: { cwd: string; hasUI: boolean; model: { provider: string; id: string }; sessionManager: { getSessionId: () => string }; ui: { notify(message: string): void; select(prompt: string, options: string[]): Promise<string | undefined>; input?: (prompt: string, placeholder?: string) => Promise<string | undefined> } }; tools: TestTool[]; toolResult: ((event: unknown) => Promise<unknown>) | undefined; selections: Array<{ prompt: string; options: string[] }>; notices: string[]; messages: string[] };
async function createRun(home: string, cwd: string, id: string, state: RunState, extra: Partial<PersistedRun> = {}, script = `return ${JSON.stringify(id)};`): Promise<RunStore> {
  const store = new RunStore(cwd, "session", id, home);
  await store.create({ id, workflowName: id, cwd, sessionId: "session", state, agents: [], agentSessions: [], ...extra }, createLaunchSnapshot({ script, args: null, metadata: { name: id }, launchMode: "background", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  return store;
}

function setup(home: string, cwd: string, selectChoice: (prompt: string, options: string[]) => string | undefined, input?: string, transport?: import("../src/agent-execution.js").AgentTransport, hasUI = true, onEvent?: (channel: string, data: unknown) => void): TestSetup {
  let start: TestSetup["start"];
  let shutdown: TestSetup["shutdown"];
  let toolResult: TestSetup["toolResult"];
  let command!: TestSetup["command"];
  const tools: TestTool[] = [];
  const selections: TestSetup["selections"] = [];
  const notices: string[] = [];
  const messages: string[] = [];
  const context = { cwd, hasUI, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); }, select: async (prompt: string, options: string[]) => { selections.push({ prompt, options }); return selectChoice(prompt, options); }, ...(input === undefined ? {} : { input: async () => input }) } };
  workflowExtension({
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = options.handler; },
    registerTool(tool: TestTool) { tools.push(tool); },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; if (name === "tool_result") toolResult = handler as TestSetup["toolResult"]; },
    sendMessage(message: { content: string }) { messages.push(message.content); },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
    ...(onEvent ? { events: { emit: onEvent } } : {}),
  } as never, home, undefined, transport);
  assert.ok(command);
  return { start, shutdown, command, context, tools, toolResult, selections, notices, messages };
}

async function startSetup(testSetup: TestSetup): Promise<void> { await testSetup.start?.({}, testSetup.context); }

async function createLivePausedRun(sourceForeground: boolean): Promise<{ testSetup: TestSetup; execution: Promise<unknown>; store: RunStore; promptCount: () => number }> {
  const home = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-live-paused-${sourceForeground ? "foreground" : "background"}-`));
  const cwd = join(home, "project");
  let releaseAgent!: () => void;
  const agentReady = new Promise<void>((resolve) => { releaseAgent = resolve; });
  let promptCount = 0;
  const transport = testTransport(async (): Promise<TestPiSession> => ({
    sessionId: "paused-session",
    messages: [{ role: "assistant", content: [{ type: "text", text: "paused-result" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => { promptCount += 1; await agentReady; },
    dispose() {},
  }));
  let resolvePaused!: (runId: string) => void;
  const paused = new Promise<string>((resolve) => { resolvePaused = resolve; });
  let pauseRequested = false;
  const testSetup = setup(home, cwd, (prompt, options) => {
    if (prompt === "Pausable workflows") return options.find((option) => option.includes("live-paused"));
    if (prompt === "Resumable workflows") return options.find((option) => option.includes("live-paused"));
    if (options.includes("Foreground")) return sourceForeground ? "Foreground" : "Background";
    return undefined;
  }, undefined, transport, true, (channel, data) => {
    if (channel === WORKFLOW_RUN_COMPLETED_EVENT && sourceForeground) { void testSetup.toolResult?.({ toolName: "workflow", toolCallId: "live-paused-tool", isError: false }); }
    if (channel !== WORKFLOW_PHASE_CHANGED_EVENT || pauseRequested) return;
    const event = data as { phase?: string; runId?: string };
    if (event.phase !== "pause" || !event.runId) return;
    pauseRequested = true;
    void testSetup.command("pause", testSetup.context).then(() => { resolvePaused(event.runId as string); });
  });
  await startSetup(testSetup);
  const workflow = testSetup.tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const execution = workflow.execute("live-paused-tool", { name: "live-paused", script: "phase('pause'); const value = await agent('paused'); phase('after'); return value;", foreground: sourceForeground }, new AbortController().signal, undefined, testSetup.context);
  void execution.catch(() => undefined);
  const runId = await paused;
  releaseAgent();
  const store = new RunStore(cwd, "session", runId, home);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "paused"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "paused");
  return { testSetup, execution, store, promptCount: () => promptCount };
}

void test("parameterless resume covers live paused runs in both execution modes without replay", async () => {
  for (const sourceForeground of [false, true]) {
    for (const mode of ["Foreground", "Background"] as const) {
      const { testSetup, execution, store, promptCount } = await createLivePausedRun(sourceForeground);
      testSetup.context.ui.select = async (prompt: string, options: string[]) => {
        testSetup.selections.push({ prompt, options });
        if (prompt === "Resumable workflows") return options.find((option) => option.includes("live-paused"));
        if (options.includes("Foreground")) return mode;
        return undefined;
      };
      await testSetup.command("resume", testSetup.context);
      for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await store.load()).run.state, "completed");
      assert.equal(promptCount(), 1);
      if (sourceForeground && mode === "Background") {
        const result = await execution as { details?: { detached?: boolean } };
        assert.equal(result.details?.detached, true);
      }
      if (mode === "Background") {
        for (let attempt = 0; attempt < 100 && testSetup.messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(testSetup.messages.filter((message) => message.startsWith("Workflow live-paused completed")).length, 1);
      } else {
        assert.deepEqual(testSetup.messages, []);
        if (!sourceForeground) assert.ok(testSetup.notices.some((message) => message.includes("live-paused") && message.includes("completed")));
      }
      assert.equal((await store.load()).run.delivery?.state, "delivered");
      await testSetup.shutdown?.();
    }
  }
});

void test("parameterless resume filters terminal runs and delivers one background completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-filter-"));
  const cwd = join(home, "project");
  await Promise.all([createRun(home, cwd, "paused-run", "paused"), createRun(home, cwd, "interrupted-run", "interrupted"), createRun(home, cwd, "budget-run", "budget_exhausted"), createRun(home, cwd, "completed-run", "completed"), createRun(home, cwd, "failed-run", "failed"), createRun(home, cwd, "stopped-run", "stopped")]);
  const testSetup = setup(home, cwd, (prompt, options) => { if (prompt.includes("interrupted workflow")) return "Skip"; if (prompt === "Resumable workflows") return options.find((option) => option.includes("interrupted-run")); if (options.includes("Background")) return "Background"; return undefined; });
  await startSetup(testSetup);
  await testSetup.command("resume", testSetup.context);
  const picker = testSetup.selections.find(({ prompt }) => prompt === "Resumable workflows");
  assert.ok(picker);
  assert.equal(picker.options.at(-1), "Cancel");
  assert.ok(picker.options.some((option) => option.includes("paused-run")));
  assert.ok(picker.options.some((option) => option.includes("interrupted-run")));
  assert.ok(picker.options.some((option) => option.includes("budget-run")));
  assert.ok(!picker.options.some((option) => option.includes("completed-run") || option.includes("failed-run") || option.includes("stopped-run")));
  assert.equal(testSetup.selections.find(({ options }) => options.includes("Foreground"))?.options.join(","), "Foreground,Background,Cancel");
  for (let attempt = 0; attempt < 100 && testSetup.messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(testSetup.messages.filter((message) => message.startsWith("Workflow interrupted-run completed")).length, 1);
  assert.equal((await new RunStore(cwd, "session", "interrupted-run", home).load()).run.state, "completed");
  await testSetup.shutdown?.();
});

void test("parameterless resume cancellation at run and mode pickers leaves the run unchanged", async () => {
  for (const cancelMode of ["run", "mode"] as const) {
    const home = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-resume-cancel-${cancelMode}-`));
    const cwd = join(home, "project");
    const store = await createRun(home, cwd, "cancel-run", "interrupted");
    const testSetup = setup(home, cwd, (prompt, options) => { if (prompt.includes("interrupted workflow")) return "Skip"; if (cancelMode === "run") return "Cancel"; if (prompt === "Resumable workflows") return options.find((option) => option.includes("cancel-run")); return "Cancel"; });
    await startSetup(testSetup);
    await testSetup.command("resume", testSetup.context);
    assert.equal((await store.load()).run.state, "interrupted");
    assert.equal(testSetup.messages.length, 0);
    await testSetup.shutdown?.();
  }
});

void test("budget adjustment reports pending approval instead of resumed", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-budget-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "budget-run", "budget_exhausted", { budget: { tokens: { hard: 1 } }, budgetVersion: 1, usage: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 } });
  const testSetup = setup(home, cwd, (prompt, options) => { if (prompt === "Resumable workflows") return options.find((option) => option.includes("budget-run")); if (options.includes("Adjust budget")) return "Adjust budget"; if (options.includes("Foreground")) return "Foreground"; return "Skip"; }, "{\"tokens\":{\"hard\":2}}");
  await startSetup(testSetup);
  await testSetup.command("resume", testSetup.context);
  assert.ok(testSetup.notices.some((message) => message.includes("awaiting approval")));
  assert.ok(!testSetup.notices.some((message) => message.includes("Resumed workflow budget-run")));
  assert.equal((await store.load()).run.state, "budget_exhausted");
  assert.equal((await store.pendingWorkflowDecisions()).length, 1);
  await testSetup.shutdown?.();
});

void test("parameterless budget resume unchanged uses the selected execution mode", async () => {
  for (const mode of ["Foreground", "Background"] as const) {
    const home = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-resume-budget-${mode.toLowerCase()}-`));
    const cwd = join(home, "project");
    const store = await createRun(home, cwd, "budget-run", "budget_exhausted", { budget: { tokens: { soft: 1 } }, budgetVersion: 1, usage: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 } });
    const testSetup = setup(home, cwd, (prompt, options) => {
      if (prompt === "Resumable workflows") return options.find((option) => option.includes("budget-run"));
      if (options.includes("Foreground")) return mode;
      if (options.includes("Resume unchanged")) return "Resume unchanged";
      return undefined;
    });
    await startSetup(testSetup);
    await testSetup.command("resume", testSetup.context);
    for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await store.load()).run.state, "completed");
    assert.equal((await store.load()).run.delivery?.mode, mode === "Foreground" ? "foreground" : "background");
    if (mode === "Foreground") {
      assert.ok(testSetup.notices.some((message) => message.includes('budget-run') && message.includes('completed') && message.includes('"budget-run"')));
      assert.deepEqual(testSetup.messages, []);
    } else {
      for (let attempt = 0; attempt < 100 && testSetup.messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(testSetup.messages.filter((message) => message.startsWith("Workflow budget-run completed")).length, 1);
    }
    await testSetup.shutdown?.();
  }
});

void test("explicit resume ID remains prompt-free", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-explicit-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "explicit-run", "interrupted");
  const testSetup = setup(home, cwd, (prompt) => prompt.includes("interrupted workflow") ? "Skip" : undefined);
  await startSetup(testSetup);
  await testSetup.command("resume explicit-run", testSetup.context);
  assert.equal(testSetup.selections.length, 1);
  for (let attempt = 0; attempt < 100 && testSetup.messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(testSetup.messages.filter((message) => message.startsWith("Workflow explicit-run completed")).length, 1);
  assert.equal((await store.load()).run.state, "completed");
  await testSetup.shutdown?.();
});

void test("parameterless resume reports no candidates", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-empty-"));
  const cwd = join(home, "project");
  const testSetup = setup(home, cwd, () => undefined);
  await testSetup.command("resume", testSetup.context);
  assert.deepEqual(testSetup.selections, []);
  assert.ok(testSetup.notices.includes("No resumable workflow runs in this Pi session."));
  await testSetup.shutdown?.();
});

void test("parameterless delete selects a single deletable run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delete-picker-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "completed-run", "completed");
  const testSetup = setup(home, cwd, (_prompt, options) => options.find((option) => option.includes("completed-run")));
  await startSetup(testSetup);
  const context = { ...testSetup.context, ui: { ...testSetup.context.ui, confirm: async () => true } };
  await testSetup.command("delete", context);
  const picker = testSetup.selections.find(({ prompt }) => prompt === "Deletable workflows");
  assert.ok(picker);
  assert.equal(picker.options.at(-1), "Cancel");
  assert.ok(picker.options.some((option) => option.includes("completed-run")));
  await assert.rejects(store.load());
  await testSetup.shutdown?.();
});

void test("parameterless stop selects a live non-terminal run and confirms", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-picker-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "interrupted-run", "interrupted");
  const testSetup = setup(home, cwd, (prompt, options) => prompt === "Stoppable workflows" ? options.find((option) => option.includes("interrupted-run")) : undefined);
  await startSetup(testSetup);
  let confirmed = false;
  const context = { ...testSetup.context, ui: { ...testSetup.context.ui, confirm: async () => { confirmed = true; return true; } } };
  await testSetup.command("stop", context);
  const picker = testSetup.selections.find(({ prompt }) => prompt === "Stoppable workflows");
  assert.ok(picker);
  assert.equal(picker.options.at(-1), "Cancel");
  assert.ok(confirmed);
  assert.equal((await store.load()).run.state, "stopped");
  assert.ok(testSetup.notices.includes("Stopped workflow interrupted-run."));
  await testSetup.shutdown?.();
});

void test("cancelling a parameterless delete picker leaves the run unchanged", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delete-cancel-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "cancel-delete", "completed");
  const testSetup = setup(home, cwd, (prompt) => prompt === "Deletable workflows" ? "Cancel" : undefined);
  await startSetup(testSetup);
  let confirmed = false;
  const context = { ...testSetup.context, ui: { ...testSetup.context.ui, confirm: async () => { confirmed = true; return true; } } };
  await testSetup.command("delete", context);
  assert.equal((await store.load()).run.state, "completed");
  assert.equal(confirmed, false);
  assert.equal(testSetup.notices.some((message) => message.startsWith("Deleted workflow")), false);
  await testSetup.shutdown?.();
});

void test("parameterless resume without UI does not choose a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-no-ui-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "no-ui-run", "interrupted");
  const testSetup = setup(home, cwd, () => undefined, undefined, undefined, false);
  await startSetup(testSetup);
  await testSetup.command("resume", testSetup.context);
  assert.equal((await store.load()).run.state, "interrupted");
  assert.deepEqual(testSetup.selections, []);
  assert.ok(testSetup.notices.includes("Interactive workflow resume selection is unavailable; provide a run ID."));
  await testSetup.shutdown?.();
});

void test("explicit resume recovers a previously delivered foreground run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-delivery-recovery-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "delivered-run", "budget_exhausted", { delivery: { mode: "foreground", state: "delivered" } });
  const testSetup = setup(home, cwd, () => undefined);
  await startSetup(testSetup);
  await testSetup.command("resume delivered-run", testSetup.context);
  for (let attempt = 0; attempt < 100 && testSetup.messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(testSetup.messages.filter((message) => message.startsWith("Workflow delivered-run completed")).length, 1);
  assert.equal((await store.load()).run.delivery?.state, "delivered");
  await testSetup.shutdown?.();
});

void test("foreground resume shows failure diagnostics in the command interaction", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-failure-"));
  const cwd = join(home, "project");
  await createRun(home, cwd, "failure-run", "interrupted", {}, `throw new Error("resume failure");`);
  const testSetup = setup(home, cwd, (prompt, options) => { if (prompt.includes("interrupted workflow")) return "Skip"; if (prompt === "Resumable workflows") return options.find((option) => option.includes("failure-run")); if (options.includes("Foreground")) return "Foreground"; return undefined; });
  await startSetup(testSetup);
  await testSetup.command("resume", testSetup.context);
  assert.ok(testSetup.notices.some((message) => message.includes("failure-run") && message.includes("error=INTERNAL_ERROR") && message.includes("artifacts:")));
  await testSetup.shutdown?.();
});
