import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore } from "../src/index.js";
import type { PersistedRun } from "../src/persistence.js";
import type { RunState } from "../src/types.js";

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

type TestSetup = { start: ((event: unknown, context: unknown) => Promise<void>) | undefined; shutdown: (() => Promise<void>) | undefined; command: (args: string, context: unknown) => Promise<void>; context: { cwd: string; hasUI: boolean; model: { provider: string; id: string }; sessionManager: { getSessionId: () => string }; ui: { notify(message: string): void; select(prompt: string, options: string[]): Promise<string | undefined>; input?: (prompt: string, placeholder?: string) => Promise<string | undefined> } }; selections: Array<{ prompt: string; options: string[] }>; notices: string[]; messages: string[] };

async function createRun(home: string, cwd: string, id: string, state: RunState, extra: Partial<PersistedRun> = {}, script = `return ${JSON.stringify(id)};`): Promise<RunStore> {
  const store = new RunStore(cwd, "session", id, home);
  await store.create({ id, workflowName: id, cwd, sessionId: "session", state, agents: [], agentSessions: [], ...extra }, createLaunchSnapshot({ script, args: null, metadata: { name: id }, launchMode: "background", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  return store;
}

function setup(home: string, cwd: string, selectChoice: (prompt: string, options: string[]) => string | undefined, input?: string): TestSetup {
  let start: TestSetup["start"];
  let shutdown: TestSetup["shutdown"];
  let command!: TestSetup["command"];
  const selections: TestSetup["selections"] = [];
  const notices: string[] = [];
  const messages: string[] = [];
  const context = { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); }, select: async (prompt: string, options: string[]) => { selections.push({ prompt, options }); return selectChoice(prompt, options); }, ...(input === undefined ? {} : { input: async () => input }) } };
  workflowExtension({
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = options.handler; },
    registerTool() {},
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    sendMessage(message: { content: string }) { messages.push(message.content); },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  } as never, home);
  assert.ok(command);
  return { start, shutdown, command, context, selections, notices, messages };
}

async function startSetup(testSetup: TestSetup): Promise<void> { await testSetup.start?.({}, testSetup.context); }

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
