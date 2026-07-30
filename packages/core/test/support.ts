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
