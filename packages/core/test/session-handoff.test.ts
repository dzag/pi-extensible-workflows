import assert from "node:assert/strict";
import test from "node:test";
import { createLiveSessionHandoff } from "../src/session-handoff.js";

void test("live session handoff waits for turn_end and releases ownership once", async () => {
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  let launched = false;
  let finishPane!: () => void;
  const paneClosed = new Promise<void>((resolve) => { finishPane = resolve; });
  const opening = handoff.request(async () => {
    launched = true;
    await paneClosed;
  });

  await Promise.resolve();
  assert.equal(launched, false);
  assert.equal(handoff.state, "handoff-pending");
  handoff.observe({ type: "turn_end" });
  await Promise.resolve();
  assert.equal(launched, true);
  assert.equal(handoff.state, "herdr-running");
  const resumed = handoff.waitForResume();
  finishPane();
  await opening;
  await resumed;
  assert.equal(handoff.state, "completed");
  handoff.release("pane.closed");
  assert.equal(handoff.state, "completed");
});

void test("live session handoff pauses the local owner until takeover", async () => {
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const opening = handoff.request(async () => {
    handoff.takeover();
  });
  const paused = handoff.waitForTakeover();
  let resolved = false;
  void paused.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  handoff.observe({ type: "turn_end" });
  await opening;
  await paused;
  assert.equal(resolved, true);
});
