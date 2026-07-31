import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore } from "../src/index.js";

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
  assert.ok(notices.some((message) => message.includes("resume-picker") && message.includes("completed")));
});
