import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_SNAPSHOT_IDENTITY_VERSION,
  DEFAULT_SETTINGS,
  agentBreadcrumb,
  buildWorkflowPhaseModel,
  createLaunchSnapshot,
  formatWorkflowPhaseDashboard,
  preflight,
  preserveWorkflowPhaseSelection,
  type AgentRecord,
  type PersistedRun,
} from "../src/index.js";
import { RunStore } from "../src/persistence.js";

function agent(id: string, state: AgentRecord["state"] = "completed", parentId?: string): AgentRecord {
  return { id, name: id, path: id, state, ...(parentId ? { parentId } : {}), model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 };
}

function run(state: PersistedRun["state"], agents: readonly AgentRecord[] = [], phaseHistory?: PersistedRun["phaseHistory"]): PersistedRun {
  return { id: "run", workflowName: "phases", cwd: "/repo", sessionId: "session", state, agents, nativeSessions: [], ...(phaseHistory ? { phaseHistory } : {}) };
}

function snapshot(phases?: readonly string[]) {
  return createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "phases" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], ...(phases ? { phases } : {}), schemas: [] });
}


void test("phase model merges empty and unstarted declarations without inventing runtime order", () => {
  const model = buildWorkflowPhaseModel(run("running", [], [{ phase: "build", afterAgent: 0 }]), ["build", "review"]);
  assert.deepEqual(model.phases.map(({ name, state }) => [name, state]), [["build", "running"], ["review", "not started"]]);
  assert.equal(model.currentPhaseId, "build#1");
  const unstarted = buildWorkflowPhaseModel(run("running"), ["build", "review"]);
  assert.deepEqual(unstarted.phases.map(({ name, state }) => [name, state]), [["build", "not started"], ["review", "not started"]]);
  assert.equal(unstarted.currentPhaseId, undefined);
});

void test("phase model preserves repeated and out-of-order observed occurrences", () => {
  const repeated = buildWorkflowPhaseModel(run("completed", [agent("a"), agent("b")], [{ phase: "build", afterAgent: 0 }, { phase: "build", afterAgent: 1 }]), ["build", "build", "review"]);
  assert.deepEqual(repeated.phases.map(({ id, observed }) => [id, observed]), [["build#1", true], ["build#2", true], ["review#1", false]]);
  const outOfOrder = buildWorkflowPhaseModel(run("running", [agent("a"), agent("b")], [{ phase: "review", afterAgent: 0 }, { phase: "build", afterAgent: 1 }]), ["build", "review"]);
  assert.deepEqual(outOfOrder.phases.map(({ name, observed }) => [name, observed]), [["review", true], ["build", true]]);
  assert.equal(outOfOrder.phases.filter(({ name }) => name === "build").length, 1);
});

void test("only the latest phase inherits terminal status and interrupted or exhausted runs stay distinct", () => {
  const history = [{ phase: "build", afterAgent: 0 }, { phase: "review", afterAgent: 1 }];
  for (const [state, latest] of [["failed", "failed"], ["stopped", "cancelled"], ["interrupted", "interrupted"], ["budget_exhausted", "budget_exhausted"]] as const) {
    const phases = buildWorkflowPhaseModel(run(state, [agent("done"), agent("done-2")], history), ["build", "review"]).phases;
    assert.deepEqual(phases.map(({ state: phaseState }) => phaseState), ["completed", latest]);
  }
});

void test("phase agent counts are explicit for every state", () => {
  const phases = buildWorkflowPhaseModel(run("running", [agent("done"), agent("live", "running"), agent("bad", "failed"), agent("cancelled", "cancelled"), agent("queued", "queued")], [{ phase: "review", afterAgent: 0 }]), ["review"]).phases;
  assert.deepEqual(phases[0]?.counts, { total: 5, completed: 1, running: 1, failed: 1, cancelled: 1, pending: 1 });
});

void test("phase launch metadata is optional, immutable, and survives old snapshot reloads", async () => {
  const checked = preflight("phase('build'); phase('build'); return true;", { models: new Set(["openai/gpt"]), tools: new Set(), agentTypes: new Set() });
  assert.deepEqual(checked.referenced.phases, ["build", "build"]);
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-phase-snapshot-"));
  const cwd = join(home, "repo");
  const store = new RunStore(cwd, "session", "run", home);
  const launch = snapshot(checked.referenced.phases);
  await store.create({ ...run("completed"), cwd }, launch);
  const loaded = await store.load();
  assert.deepEqual(loaded.snapshot.phases, ["build", "build"]);
  assert.equal(loaded.snapshot.identityVersion, LAUNCH_SNAPSHOT_IDENTITY_VERSION);
  const old = { ...launch };
  delete old.phases;
  await store.saveSnapshot(old);
  const oldLoaded = await store.load();
  assert.equal(oldLoaded.snapshot.phases, undefined);
  assert.equal(oldLoaded.snapshot.identityVersion, LAUNCH_SNAPSHOT_IDENTITY_VERSION);
});

void test("agent breadcrumbs are root-to-leaf, picker-compatible, and cycle-safe", () => {
  const root = agent("root");
  const child = agent("child", "completed", "root");
  const cycleRoot = agent("cycle-root", "completed", "cycle-child");
  const cycleChild = agent("cycle-child", "completed", "cycle-root");
  const byId = new Map([root, child, cycleRoot, cycleChild].map((value) => [value.id, value]));
  assert.equal(agentBreadcrumb(child, byId), "root > child");
  assert.equal(agentBreadcrumb({ ...child, structuralPath: ["issues", "42"], parentBreadcrumb: "review" }, byId, true), "issues > 42 > review > root > child");
  assert.equal(agentBreadcrumb(cycleRoot, byId), "cycle-child > cycle-root");
});

void test("phase dashboard keeps wide and narrow content within bounds while retaining counts", () => {
  const current = { ...run("running", [agent("done"), agent("live", "running")], [{ phase: "build", afterAgent: 0 }, { phase: "review", afterAgent: 1 }]), phase: "review" };
  const launch = snapshot(["build", "review"]);
  for (const width of [1, 10, 30, 79, 80, 120]) {
    const lines = formatWorkflowPhaseDashboard(current, launch, width);
    assert.ok(lines.every((line) => line.length <= width), `line exceeded width ${String(width)}`);
    if (width >= 10) {
      const rendered = lines.join("\n");
      for (const field of ["completed=", "running=", "failed=", "cancelled=", "pending="]) assert.match(rendered, new RegExp(field));
    }
  }
  const wide = formatWorkflowPhaseDashboard(current, launch, 120).join("\n");
  assert.match(wide, /\|/);
  const narrow = formatWorkflowPhaseDashboard(current, launch, 40).join("\n");
  assert.match(narrow, /Selected phase: review/);
});

void test("phase and agent selections survive read-model polling", () => {
  const before = buildWorkflowPhaseModel(run("running", [agent("one")], [{ phase: "build", afterAgent: 0 }]), ["build", "review"]);
  const selected = preserveWorkflowPhaseSelection(before, { phaseId: "build#1", agentId: "one" });
  const after = buildWorkflowPhaseModel(run("running", [agent("one"), agent("two")], [{ phase: "build", afterAgent: 0 }, { phase: "review", afterAgent: 1 }]), ["build", "review"]);
  assert.deepEqual(preserveWorkflowPhaseSelection(after, selected), selected);
});
