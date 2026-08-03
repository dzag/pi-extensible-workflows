import assert from "node:assert/strict";
import test from "node:test";
import { createLiveSessionHandoff } from "../src/session-handoff.js";
import { createPiRuntimeSessionAdapter, isTurnBoundaryEnd, isTurnBoundaryStart, normalizePiMessage, normalizePiSessionEvent, runtimeProgressToAgentProgress } from "../src/pi-runtime-adapter.js";
import type { WorkflowAgentSession, WorkflowAgentSessionEvent } from "../src/types.js";

const state = { model: { provider: "pi", model: "model", thinking: "medium" as const }, tools: ["read"], systemPrompt: "system" };
const stats = { tokens: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 }, cost: 0.25 };

function session(): WorkflowAgentSession {
  return {
    reference: { transport: "local", sessionId: "session" },
    getState: () => state,
    getSessionStats: () => stats,
    getLastAssistant: () => undefined,
    subscribe: () => () => undefined,
    prompt: async () => ({}),
    steer: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
  };
}

function observe(adapter: ReturnType<typeof createPiRuntimeSessionAdapter>, event: WorkflowAgentSessionEvent) {
  const observation = adapter.observe(event);
  assert.ok(observation);
  return observation;
}

void test("Pi adapter accepts only current and legacy turn boundaries", () => {
  assert.equal(isTurnBoundaryStart("turn_start"), true);
  assert.equal(isTurnBoundaryStart("turn_started"), true);
  assert.equal(isTurnBoundaryStart("turnStarted"), true);
  assert.equal(isTurnBoundaryStart("agent_start"), false);
  assert.equal(isTurnBoundaryStart("turn-started"), false);
  assert.equal(isTurnBoundaryEnd("turn_end"), true);
  assert.equal(isTurnBoundaryEnd("turnEnded"), true);
  assert.equal(isTurnBoundaryEnd("agent_end"), true);
  assert.equal(isTurnBoundaryEnd("agent_settled"), true);
  assert.equal(isTurnBoundaryEnd("turn-ended"), false);
  assert.equal(isTurnBoundaryEnd("turn_completed"), false);
  assert.equal(isTurnBoundaryEnd("message_end"), false);
});

void test("Pi adapter preserves live state, activity, timestamps, and tool lifecycle", () => {
  let now = 100;
  const adapter = createPiRuntimeSessionAdapter(session(), createLiveSessionHandoff(), () => now);

  const start = observe(adapter, { type: "tool_execution_start", toolCallId: "call", toolName: "read" });
  assert.deepEqual(start.progress.toolCalls, [{ id: "call", name: "read", state: "running" }]);
  assert.deepEqual(start.progress.state, state);
  assert.deepEqual(start.progress.usage, { availability: "complete", input: 2, output: 3, cacheRead: 5, cacheWrite: 7, costUsd: 0.25 });
  assert.deepEqual(start.progress.activity, { kind: "tool", text: "read" });
  assert.equal(start.progress.lastEventAt, 100);
  assert.equal(start.persist, false);

  state.model.model = "SWITCHED";
  state.tools.push("bash");
  state.systemPrompt = "effective prompt";
  now = 200;
  const live = observe(adapter, { type: "message_update", assistantMessageEvent: { type: "text_delta" } });
  assert.deepEqual(live.progress.state, { model: { provider: "pi", model: "SWITCHED", thinking: "medium" }, tools: ["read", "bash"], systemPrompt: "effective prompt" });
  state.model.model = "model";
  state.tools.pop();
  state.systemPrompt = "system";

  now = 300;
  const update = observe(adapter, { type: "tool_execution_update", toolCallId: "call", toolName: "read" });
  assert.deepEqual(update.progress.toolCalls, [{ id: "call", name: "read", state: "running" }]);
  assert.deepEqual(update.progress.activity, { kind: "tool", text: "read" });

  now = 400;
  const end = observe(adapter, { type: "tool_execution_end", toolCallId: "call", toolName: "read", isError: true });
  assert.deepEqual(end.progress.toolCalls, [{ id: "call", name: "read", state: "failed" }]);
  assert.equal(end.progress.activity, undefined);
  assert.equal(end.persist, false);
  const unseenUpdate = observe(adapter, { type: "tool_execution_update", toolCallId: "unseen", toolName: "read" });
  assert.deepEqual(unseenUpdate.progress.toolCalls, []);

  now = 500;
  const changed = observe(adapter, { type: "state_changed", state: { model: { provider: "other", model: "changed" }, tools: ["grep"], systemPrompt: "changed" } });
  assert.deepEqual(changed.progress.state, { model: { provider: "other", model: "changed" }, tools: ["grep"], systemPrompt: "changed" });
  assert.equal(changed.persist, true);
  assert.equal(changed.progress.lastEventAt, 500);
  adapter.dispose();
});

void test("Pi adapter normalizes turn boundaries for neutral handoff and release", async () => {
  const legacy = createLiveSessionHandoff();
  const adapter = createPiRuntimeSessionAdapter(session(), legacy);
  adapter.observe({ type: "turn_started" });
  let launched = false;
  const opening = adapter.handoff.request(async () => { launched = true; adapter.handoff.takeover(); });
  await Promise.resolve();
  assert.equal(launched, false);
  assert.equal(adapter.handoff.state, "takeover-pending");
  adapter.observe({ type: "turn_end" });
  await Promise.all([opening, adapter.handoff.waitForTakeover(), adapter.handoff.waitForResume()]);
  assert.equal(launched, true);
  assert.equal(adapter.handoff.transferred, true);
  adapter.handoff.release("test");
  assert.equal(adapter.handoff.state, "completed");
  adapter.dispose();
});

void test("Pi adapter cancellation releases pending handoff and disposal stops observations", async () => {
  const controller = new AbortController();
  const handoff = createLiveSessionHandoff();
  const adapter = createPiRuntimeSessionAdapter(session(), handoff);
  adapter.observe({ type: "turn_started" });
  let launched = false;
  const opening = adapter.handoff.request(async () => { launched = true; });
  const takeover = adapter.handoff.waitForTakeover();
  const resume = adapter.handoff.waitForResume();
  const release = () => { handoff.release("cancelled"); };
  controller.signal.addEventListener("abort", release, { once: true });
  controller.abort();
  await Promise.all([opening, takeover, resume]);
  assert.equal(launched, false);
  adapter.dispose();
  assert.equal(adapter.observe({ type: "message_end" }), undefined);
  controller.signal.removeEventListener("abort", release);
});
void test("Pi adapter defers expensive progress materialization for streaming events", () => {
  let stateReads = 0;
  let statsReads = 0;
  const base = session();
  const counted: WorkflowAgentSession = {
    ...base,
    getState: () => { stateReads += 1; return state; },
    getSessionStats: () => { statsReads += 1; return stats; },
  };
  const now = 100;
  const adapter = createPiRuntimeSessionAdapter(counted, createLiveSessionHandoff(), () => now);
  for (let index = 0; index < 200; index += 1) adapter.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
  assert.equal(stateReads, 0);
  assert.equal(statsReads, 0);
  const report = observe(adapter, { type: "tool_execution_start", toolCallId: "call", toolName: "read" });
  assert.equal(stateReads, 0);
  assert.equal(statsReads, 0);
  assert.equal(report.progress.usage.availability, "complete");
  assert.equal(stateReads, 1);
  assert.equal(statsReads, 1);
  adapter.dispose();
});
void test("Pi adapter retains the initial and elapsed heartbeat reports", () => {
  let now = 100;
  const adapter = createPiRuntimeSessionAdapter(session(), createLiveSessionHandoff(), () => now);
  assert.equal(observe(adapter, { type: "message_update", assistantMessageEvent: { type: "unknown" } }).report, true);
  now = 500;
  assert.equal(observe(adapter, { type: "message_update", assistantMessageEvent: { type: "unknown" } }).report, false);
  now = 1_100;
  assert.equal(observe(adapter, { type: "message_update", assistantMessageEvent: { type: "unknown" } }).report, true);
  adapter.dispose();
});
void test("Pi adapter skips invalid usage instead of failing the observation", () => {
  const base = session();
  const invalid: WorkflowAgentSession = { ...base, getSessionStats: () => ({ ...stats, cost: Number.NaN }) };
  const adapter = createPiRuntimeSessionAdapter(invalid, createLiveSessionHandoff());
  assert.deepEqual(observe(adapter, { type: "tool_execution_start", toolCallId: "call", toolName: "read" }).progress.usage, { availability: "unavailable" });
  adapter.dispose();
});
void test("Pi adapter rejects malformed boundary data and drops partial message usage", () => {
  assert.equal(normalizePiSessionEvent(null), undefined);
  assert.equal(normalizePiSessionEvent({}), undefined);
  assert.equal(normalizePiSessionEvent({ type: 42 }), undefined);
  assert.deepEqual(normalizePiMessage({ role: "assistant", usage: { input: 1 } }), { role: "assistant" });
});
void test("runtime progress conversion rejects incomplete usage", () => {
  assert.throws(() => runtimeProgressToAgentProgress({ usage: { availability: "partial", input: 1 }, toolCalls: [], persist: false }), /partial/);
});
