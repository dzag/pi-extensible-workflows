import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, formatNavigatorDashboard, formatNavigatorRun, formatWorkflowPhaseDashboard, formatWorkflowProgress, mergeBudget, RunStore, truncateWorkflowProgress, WORKFLOW_AGENT_STALL_THRESHOLD_MS, type PersistedRun } from "../src/index.js";
import { testTransport, type TestPiSession } from "./test-transport.js";
import { waitForIssue105 } from "./support.js";

void test("workflow progress warns after ten minutes of agent silence and resets on events", () => {
  const now = 12 * 60 * 60 * 1000;
  const agent = { id: "run:1", name: "worker", path: "run:1", state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, activity: { kind: "text" as const, text: "responding" }, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS + 1 };
  const run = { id: "run", workflowName: "stalling", cwd: "/repo", sessionId: "session", state: "running" as const, agents: [agent], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.doesNotMatch(formatWorkflowProgress(run, "◇", undefined, now), /stalled\?/);
  const atThreshold = { ...run, agents: [{ ...agent, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(atThreshold, "◇", undefined, now), /responding - stalled\? 10m/);
  const stalled = { ...run, agents: [{ ...agent, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 2 * 60 * 1000 }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(stalled, "◇", undefined, now), /responding - stalled\? 12m/);
  const longStalled = { ...run, agents: [{ ...agent, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 62 * 60 * 1000 }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(longStalled, "◇", undefined, now), /responding - stalled\? 1h 12m/);
  const stalledAgent = stalled.agents[0];
  assert.ok(stalledAgent);
  const noActivity = { ...stalled, agents: [{ ...stalledAgent, activity: undefined }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(noActivity, "◇", undefined, now), /stalled\? 12m/);
  assert.doesNotMatch(formatWorkflowProgress(noActivity, "◇", undefined, now), / - stalled\?/);
  const reset = { ...stalled, agents: [{ ...stalledAgent, lastEventAt: now }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.doesNotMatch(formatWorkflowProgress(reset, "◇", undefined, now), /stalled\?/);
  assert.match(formatNavigatorDashboard(stalled, [], [], now), /responding - stalled\? 12m/);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "stalling" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  assert.match(formatWorkflowPhaseDashboard(stalled, snapshot, 120, {}, undefined, now).join("\n"), /stalled\? 12m/);
});
void test("workflow progress shows runtime after the workflow state", () => {
  const run = { id: "run", workflowName: "runtime", cwd: "/repo", sessionId: "session", state: "running" as const, agents: [], agentSessions: [], usage: { tokens: 0, costUsd: 0, durationMs: 12_345, agentLaunches: 0 } } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(run), /\[running\] runtime=12s/);
  assert.match(formatWorkflowProgress({ ...run, state: "completed", usage: { tokens: 0, costUsd: 0, durationMs: 65_432, agentLaunches: 0 } }), /\[completed\] runtime=1m 5s/);
});
void test("inline workflow progress rebases runtime after pause and resume", () => {
  const previousNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-runtime-"));
    const tools: Array<{ name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render: (width: number) => string[] } }> = [];
    workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
    const tool = tools.find(({ name }) => name === "workflow");
    assert.ok(tool?.renderResult);
    const agent = { id: "run:1", name: "worker", path: "run:1", state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 };
    const running = { id: "run", workflowName: "runtime", cwd: home, sessionId: "session", state: "running" as const, agents: [agent], agentSessions: [], usage: { tokens: 0, costUsd: 0, durationMs: 100, agentLaunches: 0 } } as PersistedRun;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const context = { state: {}, cwd: home, invalidate: () => {} };
    tool.renderResult({ content: [], details: { run: running } }, { expanded: false, isPartial: true }, theme, context);
    now = 2_000;
    const paused = { ...running, state: "paused" as const, agents: [{ ...agent, state: "paused" as const }], usage: { ...running.usage, durationMs: 250 } };
    tool.renderResult({ content: [], details: { run: paused } }, { expanded: false, isPartial: true }, theme, context);
    now = 62_000;
    const resumed = { ...running, usage: { ...running.usage, durationMs: 250 } };
    const current = tool.renderResult({ content: [], details: { run: resumed } }, { expanded: false, isPartial: true }, theme, context);
    assert.match(current.render(200).join("\n"), /runtime=0s/);
    tool.renderResult({ content: [], details: { run: { ...resumed, state: "completed" as const } } }, { expanded: false, isPartial: false }, theme, context);
  } finally {
    Date.now = previousNow;
  }
});
void test("workflow progress shows active shell operations without command contents", () => {
  const run = { id: "run", workflowName: "shell-progress", cwd: "/repo", sessionId: "session", state: "running" as const, agents: [], agentSessions: [], activeShells: 2 } as Parameters<typeof formatWorkflowProgress>[0];
  const progress = formatWorkflowProgress(run);
  assert.match(progress, /shell \[running\] \(2 active\)/);
  assert.doesNotMatch(progress, /command-secret/);
  const legacy = { ...run };
  delete legacy.activeShells;
  assert.doesNotMatch(formatWorkflowProgress(legacy), /shell \[running\]/);
});
void test("navigator keeps agent rows compact while preserving identity and state", () => {
  const run = { id: "run", workflowName: "policy", cwd: "/repo", sessionId: "session", state: "running", agents: [{ id: "run:1", name: "review", path: "run:1", state: "running", role: "reviewer", model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read", "grep"], attempts: 1 }], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const dashboard = formatNavigatorDashboard(run, [], []);
  assert.match(dashboard, /⠦ review · running/);
  assert.doesNotMatch(dashboard, /model=|requested=|tools=|role=/);
  assert.doesNotMatch(dashboard, /Launch models/);
});
void test("compact TUI hides budgets without effective limits", () => {
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "render" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const render = (budget: unknown): string => {
    const run = { id: "run", workflowName: "render", cwd: "/repo", sessionId: "session", state: "running", agents: [], agentSessions: [], ...(budget === undefined ? {} : { budget }) } as Parameters<typeof formatWorkflowProgress>[0];
    return [formatWorkflowProgress(run), formatNavigatorDashboard(run, [], []), formatNavigatorRun({ run, snapshot }, [], [])].join("\n");
  };
  for (const budget of [undefined, {}, { tokens: {} }]) assert.doesNotMatch(render(budget), /Budget|unlimited|tokens|costUsd|durationMs|agentLaunches/);
  const partial = render({ tokens: { hard: 10 } });
  assert.match(partial, /Budget version/);
  assert.match(partial, /tokens:/);
  assert.doesNotMatch(partial, /costUsd:|durationMs:|agentLaunches:/);
  const fullBudget = { tokens: { soft: 1, hard: 2 }, costUsd: { soft: 1, hard: 2 }, durationMs: { soft: 1, hard: 2 }, agentLaunches: { soft: 1, hard: 2 } };
  const full = render(fullBudget);
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"]) assert.match(full, new RegExp(`${dimension}:`));
  const removed = mergeBudget(fullBudget, { tokens: null, costUsd: null, durationMs: null, agentLaunches: null });
  assert.deepEqual(removed, {});
  assert.doesNotMatch(render(removed), /Budget|unlimited|tokens|costUsd|durationMs|agentLaunches/);
});
void test("navigator uses persisted labels and model fallbacks across views", () => {
  const run = { id: "run", workflowName: "labels", cwd: "/repo", sessionId: "session", state: "running", agents: [
    { id: "run:1", name: "stale-name", label: "explicit label", path: "run:1", state: "running", model: { provider: "provider", model: "worker" }, tools: [], attempts: 1 },
    { id: "run:2", name: "worker", path: "run:2", state: "completed", parentId: "run:1", model: { provider: "provider", model: "worker" }, tools: [], attempts: 1 },
  ], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const dashboard = formatNavigatorDashboard(run, [], []);
  const progress = formatWorkflowProgress(run);
  const detail = formatNavigatorRun({ run, snapshot: createLaunchSnapshot({ script: "return 1;", args: null, metadata: { name: "labels" }, settings: DEFAULT_SETTINGS, models: ["provider/worker"], tools: [], agentTypes: [], schemas: [] }) }, [], []);
  assert.match(dashboard, /explicit label > worker/);
  assert.match(progress, /explicit label/);
  assert.match(detail, /explicit label .*model=provider\/worker/);
  assert.match(detail, /worker .*model=provider\/worker/);
  assert.doesNotMatch(`${dashboard}\n${detail}`, /role=custom/);
});

void test("streams foreground workflow progress into its tool card", async () => {
  type Update = { content: Array<{ type: string; text: string }>; details: { run: { state: string; phase?: string } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-progress-"));
  workflowExtension({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {},
  } as never, home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const updates: Update[] = [];
  const result = await tool.execute("id", { name: "progress", script: `phase('work'); return true;`, foreground: true }, new AbortController().signal, (update: Update) => { updates.push(update); }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { run: Parameters<typeof formatWorkflowProgress>[0] } };
  assert.ok(updates.some(({ details }) => details.run.phase === "work"));
  assert.equal(updates.at(-1)?.details.run.state, "completed");
  assert.match(formatWorkflowProgress(result.details.run), /✓ Workflow: progress/);
});
void test("inline workflow progress refreshes persisted state for stalled agents", async () => {
  type Rendered = { render: (width: number) => string[]; invalidate?: () => void };
  type WorkflowTool = { name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => Rendered };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-stall-"));
  const store = new RunStore(home, "session", "run", home);
  const staleAt = Date.now() - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 1;
  const agent = { id: "run:1", name: "worker", path: "run:1", state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, activity: { kind: "text" as const, text: "responding" }, lastEventAt: staleAt };
  const persistedRun = { id: "run", workflowName: "inline-stall", cwd: home, sessionId: "session", state: "running" as const, agents: [agent], agentSessions: [] } as PersistedRun;
  await store.create(persistedRun, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "inline-stall" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] }));
  const visibleRun = { ...persistedRun, agents: [{ ...agent, lastEventAt: Date.now() }] };
  const tools: WorkflowTool[] = [];
  workflowExtension({ registerTool(tool: WorkflowTool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool?.renderResult);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const result = { content: [], details: { run: visibleRun } };
  const context = { state: {}, cwd: home, invalidate: () => { current.invalidate?.(); } };
  const current = tool.renderResult(result, { expanded: false, isPartial: true }, theme, context);
  assert.doesNotMatch(current.render(200).join("\n"), /stalled\?/);
  assert.match(current.render(200).join("\n"), /runtime=0s/);
  await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
  assert.match(current.render(200).join("\n"), /runtime=1s/);
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  const refreshed = tool.renderResult(result, { expanded: false, isPartial: true }, theme, context);
  assert.equal(refreshed, current);
  assert.match(refreshed.render(200).join("\n"), /stalled\? 10m/);
  tool.renderResult({ content: [], details: { run: { ...visibleRun, state: "completed" as const, agents: [] } } }, { expanded: false, isPartial: false }, theme, context);
});
void test("foreground workflow progress reports a shell waiting after agents settle", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-progress-"));
  const startedPath = join(home, "shell-started");
  const releasePath = join(home, "shell-release");
  const command = `${process.execPath} -e ${JSON.stringify(`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(startedPath)},"started");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.exit(0);}},1);`)}`;
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const createSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "shell-progress-agent", locator: { sessionFile: "/sessions/shell-progress-agent.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} });
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const updates: PersistedRun[] = [];
  let reportActive!: () => void;
  const active = new Promise<void>((resolve) => { reportActive = resolve; });
  const running = workflow.execute("id", { name: "shell-progress", script: `await agent("finish", {label:"worker"}); await shell(${JSON.stringify(command)}); return true;`, foreground: true }, new AbortController().signal, (update: { details: { run: PersistedRun } }) => {
    const run = update.details.run;
    updates.push(run);
    if (run.activeShells === 1) reportActive();
  }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await active;
  await waitForIssue105(() => existsSync(startedPath));
  const live = updates.find(({ activeShells }) => activeShells === 1);
  assert.ok(live);
  assert.equal(live.agents.every((agent) => agent.state === "completed"), true);
  assert.match(formatWorkflowProgress(live), /shell \[running\] \(1 active\)/);
  writeFileSync(releasePath, "release");
  const result = await running as { details: { run: PersistedRun } };
  assert.equal(result.details.run.activeShells, undefined);
  assert.equal(updates.some(({ activeShells }) => activeShells === undefined), true);
});

void test("foreground workflow reports parallel agent activities together", { timeout: 5000 }, async () => {
  type Update = { details: { run: { agents: Array<{ activity?: { kind: string; text: string } }> } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-parallel-progress-"));
  let session = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const createSession = async (): Promise<TestPiSession> => {
    const id = ++session;
    const toolName = id === 1 ? "read" : "grep";
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    return {
      sessionId: `parallel-${String(id)}`, sessionFile: `/sessions/parallel-${String(id)}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      subscribe(candidate) { listener = candidate; return () => {}; },
      async prompt() {
        listener?.({ type: "tool_execution_start", toolCallId: `call-${String(id)}`, toolName, args: {} });
        await hold;
        listener?.({ type: "tool_execution_end", toolCallId: `call-${String(id)}`, toolName, result: {}, isError: false });
      },
      steer: async () => {},
      dispose() {},
    };
  };
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "read", "grep"], on() {} } as never, home, async () => {}, testTransport(createSession));
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const seen = new Set<string>();
  let combined = false;
  let resolveReported!: () => void;
  const reported = new Promise<void>((resolve) => { resolveReported = resolve; });
  const execution = tool.execute("id", { name: "parallel-progress", script: `return Promise.all([agent("one", {label:"first"}), agent("two", {label:"second"})]);`, concurrency: 2, foreground: true }, new AbortController().signal, (update: Update) => {
    const activities = update.details.run.agents.flatMap(({ activity }) => activity?.kind === "tool" ? [activity.text] : []);
    for (const activity of activities) seen.add(activity);
    if (activities.length === 2) combined = true;
    if (seen.has("read") && seen.has("grep")) resolveReported();
  }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await reported;
  release();
  await execution;
  assert.equal(combined, true);
});

void test("workflow progress keeps each agent to one line with latest tool", () => {
  const run = { id: "run", workflowName: "live", cwd: "/repo", sessionId: "session", state: "running", phase: "work", agents: [{ id: "run:1", name: "review", path: "run:1", state: "running", model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, tools: ["read"], attempts: 1, accounting: { input: 120, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0.01 }, toolCalls: [{ id: "call-1", name: "ls", state: "completed" }, { id: "call-2", name: "read", state: "running" }] }], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const rendered = formatWorkflowProgress(run);
  assert.match(rendered, /#1 ◇ review \[running\] ◇ read/);
  assert.doesNotMatch(rendered, /Model:/);
  assert.doesNotMatch(rendered, /Tokens:/);
  assert.doesNotMatch(rendered, /✓ ls/);
  assert.match(formatWorkflowProgress(run, "⠙"), /⠙ Workflow:[\s\S]*#1 ⠙ review \[running\] ⠙ read/);
  const agent = run.agents[0];
  assert.ok(agent);
  const reasoning = { ...run, agents: [{ ...agent, activity: { kind: "reasoning" as const, text: "checking cache" } }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(reasoning), /reasoning/);
  assert.doesNotMatch(formatWorkflowProgress(reasoning), /checking cache/);
  const text = { ...run, agents: [{ ...agent, activity: { kind: "text" as const, text: "streaming answer" } }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(text), /responding/);
  assert.doesNotMatch(formatWorkflowProgress(text), /streaming answer/);
  const settled = { ...run, agents: [{ ...agent, state: "completed" as const, activity: { kind: "text" as const, text: "stale output" } }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.doesNotMatch(formatWorkflowProgress(settled), /stale output|◇ read/);
});
void test("workflow progress applies semantic styles without coloring agent names", () => {
  const styles = {
    accent: (text: string) => `<accent>${text}</accent>`,
    success: (text: string) => `<success>${text}</success>`,
    error: (text: string) => `<error>${text}</error>`,
    warning: (text: string) => `<warning>${text}</warning>`,
    muted: (text: string) => `<muted>${text}</muted>`,
    dim: (text: string) => `<dim>${text}</dim>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  };
  const run = { id: "run", workflowName: "styled", cwd: "/repo", sessionId: "session", state: "budget_exhausted", phase: "work", agents: [
    { id: "run:1", name: "done", path: "run:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:2", name: "live", path: "run:2", state: "running", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, activity: { kind: "text" as const, text: "answer" } },
    { id: "run:3", name: "waiting", path: "run:3", state: "queued", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:4", name: "failed", path: "run:4", state: "failed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:5", name: "cancelled", path: "run:5", state: "cancelled", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
  ], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const progress = formatWorkflowProgress(run, "@", styles);
  assert.match(progress, /<bold><accent>Workflow: styled/);
  assert.match(progress, /<warning>!<\/warning>/);
  assert.match(progress, /<success>✓<\/success> done <success>\[completed\]<\/success>/);
  assert.match(progress, /<accent>@<\/accent> live <accent>\[running\]<\/accent> <accent>@<\/accent> <dim>responding<\/dim>/);
  assert.match(progress, /<muted>○<\/muted> waiting <muted>\[queued\]<\/muted>/);
  assert.match(progress, /<error>✗<\/error> failed <error>\[failed\]<\/error>/);
  assert.match(progress, /<error>✗<\/error> cancelled <error>\[cancelled\]<\/error>/);
  assert.doesNotMatch(progress, /<accent>[^<]*live/);
});
void test("workflow progress truncation closes ANSI styles within terminal width", () => {
  const line = "\u001b[36m@\u001b[0m \u001b[1m\u001b[36mWorkflow: very-long-name (0/0 done)\u001b[0m\u001b[0m";
  const stripAnsi = (value: string): string => value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  for (const width of [1, 20]) {
    const rendered = truncateWorkflowProgress(line, width)[0] ?? "";
    assert.ok(stripAnsi(rendered).length <= width);
    assert.equal(rendered.endsWith("\u001b[0m"), true);
  }
  assert.equal(stripAnsi(truncateWorkflowProgress(line, 1)[0] ?? ""), "…");
});
void test("workflow cards group structural scopes with stable creation order", () => {
  const run = { id: "run", workflowName: "grouped", cwd: "/repo", sessionId: "session", state: "running", agents: [
    { id: "run:1", name: "developer", path: "run:1", state: "completed", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:2", name: "developer", path: "run:2", state: "running", structuralPath: ["issues", "issue-66"], parentBreadcrumb: "developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:3", name: "reviewer", path: "run:3", state: "running", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:4", name: "child", path: "run:4", state: "running", parentId: "run:3", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
  ], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const progress = formatWorkflowProgress(run);
  const dashboard = formatNavigatorDashboard(run, [], [{ owner: "worktree/named/issue-65", branch: "hidden", path: "/hidden", cwd: "/hidden", base: "base" }]);
  assert.match(progress, /issues > issue-65 > developUntilApproved/);
  assert.match(dashboard, /issues > issue-65 > developUntilApproved/);
  assert.doesNotMatch(dashboard, /worktree\/named|hidden|\/hidden/);
  assert.ok(progress.indexOf("#1") < progress.indexOf("#3"));
  assert.ok(progress.indexOf("#3") < progress.indexOf("#4"));
  assert.ok(progress.indexOf("#3") < progress.indexOf("#2"));
  assert.match(progress, /#4 ◇ child/);
});
void test("workflow progress keeps top-level agents separate from review-loop groups", () => {
  const run = { id: "run", workflowName: "mixed", cwd: "/repo", sessionId: "session", state: "running", agents: [
    { id: "run:1", name: "scout", path: "run:1", state: "completed", structuralPath: [], model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:2", name: "developer", path: "run:2", state: "running", structuralPath: [], parentBreadcrumb: "reviewLoop.developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
  ], agentSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const progress = formatWorkflowProgress(run);
  assert.match(progress, / {2}Agents\n {4}#1 ✓ scout \[completed\]/);
  assert.match(progress, / {2}reviewLoop\.developUntilApproved\n {4}#2 ◇ developer \[running\]/);
});
