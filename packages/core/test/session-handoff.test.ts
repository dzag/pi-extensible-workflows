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

void test("live session handoff observes event aliases and settles waiters after launch failure", async () => {
  for (const startType of ["turn_start", "turn_started", "turnStarted", "agent_start"] as const) {
    for (const endType of ["turn_end", "turnEnded", "agent_end", "agent_settled"] as const) {
      const handoff = createLiveSessionHandoff();
      handoff.observe({ type: startType });
      let launched = false;
      const opening = handoff.request(async () => { launched = true; throw new Error("pane failed"); });
      const takeover = handoff.waitForTakeover();
      const resumed = handoff.waitForResume();
      handoff.observe({ type: endType });
      await assert.rejects(opening, /pane failed/);
      await takeover;
      await resumed;
      assert.equal(launched, true);
      assert.equal(handoff.state, "completed");
    }
  }
});

void test("duplicate handoff requests share one launch and settle together", async () => {
  const handoff = createLiveSessionHandoff();
  let launches = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const launch = async () => { launches += 1; await gate; };
  const first = handoff.request(launch);
  const second = handoff.request(async () => { launches += 1; });
  release();
  await Promise.all([first, second]);
  assert.equal(launches, 1);
  assert.equal(handoff.state, "completed");
});
