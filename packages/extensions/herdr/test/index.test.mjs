import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import extension, { breadcrumbLabel, createHerdrExtension, isFullyInspectableMode } from "../index.js";
import { createLiveSessionHandoff } from "pi-extensible-workflows";

void test("uses the global extension setting and complete breadcrumb labels", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-settings-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  assert.equal(isFullyInspectableMode(agentDir), true);
  assert.equal(breadcrumbLabel({ structuralPath: ["review", "nested"], parentBreadcrumb: "reviewLoop", callSite: "function:agent/foo", occurrence: 2 }, 3), "review > nested > reviewLoop > function:agent/foo #3");
});

void test("registers only the live-session action when enabled", () => {
  const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-default-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" } });
  assert.deepEqual(Object.values(extension.agentAttemptActions ?? {}).map(({ label }) => label), ["Open live session in Herdr pane"]);
  const context = { liveSession: {}, prepared: {}, handoff: {}, attempt: {}, agent: {}, run: {}, signal: new AbortController().signal, ui: {} };
  assert.equal(extension.agentAttemptActions.openLiveSession.visible(context), true);
  assert.equal(extension.agentAttemptActions.openLiveSession.visible({ ...context, liveSession: undefined }), false);
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-full-action-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "agent", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(root, "agent", "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const fullyInspectable = createHerdrExtension({ agentDir: join(root, "agent"), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" } });
  assert.equal(fullyInspectable.agentAttemptActions.openLiveSession.visible(context), false);
});

void test("opens the active session after the handoff boundary and releases on pane exit", async () => {
  const calls = [];
  let runCommand;
  let processReports = 0;
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "run") {
      const script = /sh '([^']+)'$/.exec(args[3]);
      runCommand = script ? readFileSync(script[1], "utf8") : args[3];
    }
    if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "pane", rect: { width: 80, height: 20 } }] } } });
    if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "new-pane" } } });
    if (args[1] === "process-info") {
      processReports += 1;
      return JSON.stringify({ result: { process_info: { foreground_processes: processReports === 2 ? [{ name: "node", argv: ["node", "/home/node/bin/pi"], cmdline: "node /home/node/bin/pi" }] : [] } } });
    }
    if (args[0] === "agent") return JSON.stringify({ result: { agent: { agent_status: "working" } } });
    return "";
  };
  const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-default-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const ownership = [];
  const longExtensionPaths = Array.from({ length: 34 }, (_, index) => `/agent/extensions/${"x".repeat(70)}-${String(index)}.mjs`);
  const longSkillPaths = Array.from({ length: 24 }, (_, index) => `/agent/skills/${"x".repeat(70)}-${String(index)}/SKILL.md`);
  const session = { reference: { transport: "local", sessionId: "session", locator: { sessionFile: "/tmp/session.jsonl" } }, suspendForHandoff: async () => ownership.push("suspend"), abort: async () => ownership.push("abort"), resumeFromHandoff: async () => ownership.push("resume"), getLastAssistant: () => ({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }), getHerdrResourcePaths: () => ({ extensions: ["/allowed-extension.mjs", ...longExtensionPaths], skills: ["/allowed-skill/SKILL.md", ...longSkillPaths] }) };
  const prepared = { cwd: "/repo", agentDir: "/agent", model: { provider: "openai", model: "gpt", thinking: "high" }, tools: ["read"], systemPrompt: "system", systemPromptAppend: "append", systemPromptPath: "/workflow/SYSTEM.md", extensionFactories: [function (pi) { pi.registerCommand("inline", { handler() {} }); }], additionalSkillPaths: ["/skill"], resourcePolicy: { projectTrusted: false, effective: { extensions: ["*"], skills: ["*"] } }, sessionLabel: "flow:review:attempt-1" };
  const promise = extension.agentAttemptActions.openLiveSession.run({ liveSession: session, prepared, handoff, attempt: { attempt: 1 }, agent: { structuralPath: ["review"], parentBreadcrumb: "flow" }, run: {}, signal: new AbortController().signal, ui: {} });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  handoff.observe({ type: "turn_end" });
  await promise;
  const runCall = calls.find(([command, subcommand]) => command === "pane" && subcommand === "run");
  assert.equal(calls.filter(([command, subcommand]) => command === "pane" && subcommand === "run").length, 1);
  assert.ok(runCall);
  assert.ok(runCall[3].length < 4096);
  assert.ok(runCommand);
  assert.ok(runCommand.includes("PI_CODING_AGENT_DIR='/agent'"));
  assert.ok(runCommand.includes("--model 'openai/gpt:high'"));
  assert.ok(runCommand.includes("--tools 'read'"));
  assert.match(runCommand, /--system-prompt '\/tmp\/pi-herdr-system-prompt-/);
  assert.match(runCommand, /--append-system-prompt '\/tmp\/pi-herdr-append-prompt-/);
  assert.ok(runCommand.includes("--skill '/skill'"));
  assert.ok(runCommand.includes("--extension '/allowed-extension.mjs'"));
  assert.ok(runCommand.includes("--skill '/allowed-skill/SKILL.md'"));
  assert.match(runCommand, /--no-extensions/);
  assert.match(runCommand, /--no-skills/);
  assert.match(runCommand, /--no-approve/);
  assert.ok(runCommand.includes("'Continue the current workflow task from this session.'"));
  assert.doesNotMatch(runCommand, /@'\/tmp\/pi-herdr-prompt-/);
  assert.match(runCommand, /--extension '.*pi-herdr-extensions-/);
  assert.ok(calls.some(([command, subcommand]) => command === "pane" && subcommand === "release-agent"));
  assert.equal(handoff.state, "completed");
  assert.ok(runCommand.length > 4096);
  assert.deepEqual(ownership, ["suspend", "resume"]);
});
void test("does not open a pane after a terminal assistant response", async () => {
  const calls = [];
  const ownership = [];
  const runner = async (args) => { calls.push([...args]); return ""; };
  const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-terminal-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const session = { reference: { transport: "local", sessionId: "session" }, getLastAssistant: () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "completed report" }] }), suspendForHandoff: async () => ownership.push("suspend"), resumeFromHandoff: async () => ownership.push("resume") };
  const opening = extension.agentAttemptActions.openLiveSession.run({ liveSession: session, prepared: {}, handoff, attempt: { attempt: 1 }, agent: {}, run: {}, signal: new AbortController().signal, ui: {} });
  handoff.observe({ type: "turn_end" });
  await opening;
  assert.equal(calls.some(([command, subcommand]) => command === "pane" && subcommand === "run"), false);
  assert.deepEqual(ownership, []);
});
void test("reports terminal turns as idle", async () => {
  const handlers = new Map();
  const calls = [];
  extension({
    on(name, handler) { handlers.set(name, handler); },
    events: { on(name, handler) { handlers.set(name, handler); } },
  }, {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane", PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER: "1" },
    runner: async (args) => { calls.push([...args]); return ""; },
  });
  const context = { hasUI: true, isIdle: () => false, sessionManager: { getSessionId: () => "session", getSessionFile: () => "/tmp/session.jsonl" } };
  await handlers.get("session_start")({ reason: "workflow-agent" }, context);
  await handlers.get("turn_end")({ message: { content: [{ type: "text", text: "done" }] } }, context);
  await handlers.get("agent_start")({}, context);
  await handlers.get("turn_end")({ message: { content: [{ type: "toolCall", name: "workflow_result" }] } }, context);
  await handlers.get("agent_start")({}, context);
  await handlers.get("agent_settled")({}, context);
  assert.deepEqual(calls.filter(([command, subcommand]) => command === "pane" && subcommand === "report-agent").map((args) => args[args.indexOf("--state") + 1]), ["working", "idle", "working", "idle", "working", "idle"]);
});

void test("routes fully inspectable agents into one labeled workflow workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-full-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const calls = [];
  let runCommand;
  let agentReports = 0;
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "run") {
      const script = /sh '([^']+)'$/.exec(args[3]);
      runCommand = script ? readFileSync(script[1], "utf8") : args[3];
    }
    if (args[0] === "workspace") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } } });
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", argv: ["pi"] }] } } });
    if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { agent_status: agentReports++ % 2 === 0 ? "working" : "idle" } } });
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const prepared = { cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: ["read"], systemPromptPath: "/repo/.pi/pi-extensible-workflows/SYSTEM.md", initialPrompt: "x".repeat(5000), sessionLabel: "flow:review:attempt-1" };
  let received;
  const agent = { transport: { id: "local", async createSession(value) { received = value; return { reference: { transport: "local", sessionId: "session" }, getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), subscribe: () => () => {}, prompt: async () => ({}), steer: async () => {}, abort: async () => {}, dispose: async () => {} }; } } };
  const identity = { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "function:agent/work", occurrence: 1 };
  extension.agentSetupHooks.fullyInspectable.setup(agent, { identity, run: { runId: "run", workflow: { name: "flow" } }, signal: new AbortController().signal, tuiIndex: 1, tuiLabel: "reviewer" });
  const session = await agent.transport.createSession(prepared, { identity, attempt: 1 });
  assert.equal(received, prepared);
  assert.equal(session.reference.transport, "herdr");
  await session.prompt("continue");
  const secondSession = await agent.transport.createSession(prepared, { identity, attempt: 2 });
  assert.deepEqual(calls[0], ["workspace", "create", "--cwd", "/repo", "--label", "workflow flow", "--no-focus"]);
  assert.deepEqual(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "create"), [
    ["tab", "create", "--workspace", "workspace", "--cwd", "/repo", "--label", "#1 reviewer", "--no-focus"],
    ["tab", "create", "--workspace", "workspace", "--cwd", "/repo", "--label", "#1 reviewer", "--no-focus"],
  ]);
  await secondSession.prompt("continue");
  await session.dispose();
  await secondSession.dispose();
  assert.equal(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "close").length, 2);
  const runCall = calls.find(([command, subcommand]) => command === "pane" && subcommand === "run");
  assert.ok(runCall);
  assert.ok(runCommand.includes("--system-prompt '/repo/.pi/pi-extensible-workflows/SYSTEM.md'"));
  assert.ok(runCommand.includes("@'/tmp/pi-herdr-prompt-"));
  assert.ok(runCommand.length < 4096);
});
