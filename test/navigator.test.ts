/**
 * Navigator TUI tests — runs a real Pi session in a herdr pane and inspects
 * what the TUI actually renders for `/workflow`.
 *
 * Requires: HERDR_ENV=1, pi CLI with auth, built dist/.
 * Run: node --test dist/test/navigator.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TestHarness } from "./harness.js";

void test("navigator shows attention-ordered runs and the selected phase tree in the real TUI", { skip: !process.env.HERDR_ENV }, async () => {
  const h = TestHarness.create({ prefix: "nav" });
  try {
    // Write fixtures BEFORE launching Pi
    await h.addRun({
      workflowName: "deploy",
      state: "completed",
      agents: [{ name: "deployer", state: "completed", accounting: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.03 } }],
    });
    await h.addRun({
      workflowName: "build",
      state: "running",
      phase: "review",
      agents: [
        { id: "b:1", name: "scout", state: "completed" },
        { id: "b:2", name: "reviewer", state: "running", parentId: "b:1", model: { thinking: "high" }, toolCalls: [{ id: "tc1", name: "read", state: "running" }] },
      ],
    });
    await h.addRun({
      workflowName: "test-suite",
      state: "failed",
      agents: [{ name: "tester", state: "failed", attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "s", sessionFile: "/s", error: { code: "AGENT_FAILED", message: "assertion failed" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
    });

    await h.launch();
    await h.waitFor("interrupted", 10_000);
    h.sendKey("ctrl+c");
    await new Promise((resolve) => setTimeout(resolve, 500));
    h.send("/workflow");
    await h.waitFor("Close", 10_000);

    const screen = h.readPane(40);
    const normalized = screen.replace(/\s+/g, " ");

    const buildLine = normalized.indexOf("build interrupted");
    const testLine = normalized.indexOf("test-suite failed");
    const deployLine = normalized.indexOf("deploy completed");

    assert.ok(buildLine >= 0, `Expected 'build interrupted' in screen:\n${screen}`);
    assert.ok(testLine >= 0, `Expected 'test-suite failed' in screen:\n${screen}`);
    assert.ok(deployLine >= 0, `Expected 'deploy completed' in screen:\n${screen}`);
    assert.ok(buildLine < testLine, `interrupted should appear before failed`);
    assert.ok(testLine < deployLine, `failed should appear before completed`);
    assert.ok(screen.includes("Close"), `Expected 'Close' option`);

    // The herdr pane is narrower than the 80-column wide-layout threshold, so
    // the overlay renders tree-only and Enter drills in one level at a time.
    h.sendKey("enter");
    await h.waitFor("Tree", 10_000);
    const detail = h.readVisiblePane();
    assert.match(detail, /Tree/);
    assert.match(detail, /review/);
    assert.doesNotMatch(detail, /Agents\.\.\./);

    // Walk the tree until an agent leaf is selected.
    let selectedAgent = "";
    for (let step = 0; step < 12; step += 1) {
      const match = /→.*?(scout|reviewer)/.exec(h.readVisiblePane());
      if (match) { selectedAgent = match[1] ?? ""; break; }
      h.sendKey("down");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    assert.ok(selectedAgent, "expected an agent row to be selected");

    // First Enter opens details for the selected agent.
    h.sendKey("enter");
    await h.waitFor(`Selected agent: ${selectedAgent}`, 10_000);

    // Second Enter on an agent opens its actions.
    h.sendKey("enter");
    await h.waitFor("Agent actions", 10_000);
    const withActions = h.readVisiblePane();
    assert.match(withActions, /Copy agent ID/, `expected inline agent actions:\n${withActions}`);
    assert.match(withActions, /→ Copy agent ID/, `expected a selected action row:\n${withActions}`);
  } finally {
    await h.close();
  }
});
