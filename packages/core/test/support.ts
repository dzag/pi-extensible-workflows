import assert from "node:assert/strict";
import type { WorkflowExtension } from "../src/index.js";

export const reuseExtension: WorkflowExtension = { version: "1.0.0", headline: "Reusable", description: "Reusable test workflows", functions: { inspect: { description: "Inspect", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => "ok" }, hello: { description: "Say hello", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, output: { type: "string" }, run: (input) => typeof input.name === "string" ? input.name : "" } } };
export async function waitForIssue105(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await check()) return;
    if (attempt % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for issue #105 test gate");
}

type WorkflowCommand = (args: string, context: unknown) => Promise<void>;
export async function contextualWorkflowAction(command: WorkflowCommand, source: Record<string, unknown>, runId: string, action: string | ((options: string[]) => string | undefined), mode: "Foreground" | "Background" = "Foreground", confirm = true): Promise<void> {
  let picked = false;
  let used = false;
  const baseUi = source.ui as { notify: (message: string) => void };
  const select = async (prompt: string, options: string[]): Promise<string> => {
    if (options.includes("Skip")) return "Skip";
    if (prompt === "Workflows\n") {
      if (picked) return "Close";
      picked = true;
      return options.find((option) => option.includes(runId)) ?? options[0] ?? "Close";
    }
    if (prompt.startsWith("Resume ")) return mode;
    if (options.includes("Approve")) return "Approve";
    if (typeof action === "function") return action(options) ?? "Back";
    if (!used && options.includes(action)) { used = true; return action; }
    return "Back";
  };
  const ui = { ...baseUi, select, confirm: async () => confirm };
  await command("", { ...source, hasUI: true, mode: "rpc", ui });
}
