# Running the workflow engine on non-Pi hosts

Research note, 2026-07-27. Not a commitment, not a plan. Written so a future
attempt starts from the findings instead of re-deriving them.

Two inputs: a parallel scout of the Codex / OpenCode / Claude Code plugin
systems plus a coupling audit of this repo (run
`ac42a827-4c1a-4336-8699-6190b20dc5e2`), and a read of
[heggria/taskflow](https://github.com/heggria/taskflow) at `3c2dfdb` (v0.2.6),
which already ships this exact port across five hosts.

## The finding that changes the shape of the problem

The first research pass assumed the port meant abstracting over each host's
nested-session API, and concluded it was near-impossible: no host but Pi
exposes one.

That premise is wrong. taskflow does not use nested-session APIs anywhere,
including on Pi. Every host ships a headless JSON-streaming CLI, and each
runner spawns one subprocess per agent task:

| Host | Transport |
|---|---|
| Pi | `pi --mode json -p` |
| Codex | `codex exec --json --skip-git-repo-check -s <sandbox>` |
| Claude Code | `claude -p --output-format stream-json` |
| OpenCode | `opencode run --format json --dir --auto` |

Each folds host-specific JSONL into one neutral result type. Cost: 312-441 LOC
per host, 1,605 total for four hosts (`packages/taskflow-hosts/src/`).

Subprocess-per-agent is not a proof-of-concept shortcut. It is the shipped
production architecture, and it is what makes the port tractable.

## The seam

`taskflow-core/src/host/runner-types.ts`, ~130 lines, imports no host SDK:

```ts
interface SubagentRunner<TAgent> {
  readonly usageAccounting?: "available" | "tokens-only" | "unavailable";
  runTask(defaultCwd, agents, agentName, task, opts: RunOptions, globalThinking?): Promise<RunResult>
}
```

- `RunOptions`: model, thinking, tools, cwd, `AbortSignal`, `onLive` progress
  callback, `idleTimeoutMs`.
- `RunResult`: exitCode, output, stderr, usage, stopReason, plus completion
  forensics (`idleTimeout`, `phaseTimeout`, `completionSource`,
  `reapedAfterTerminal`).
- Contract rule: a runner never throws for an ordinary agent failure. It sets
  `exitCode` / `stopReason` / `errorMessage` so the engine owns retry policy.

Flatter than the `AgentHost` / `AgentSession` interface the first pass
proposed. That design had an event iterable and `steer()`, modelled on Pi's
capabilities, and no other host can satisfy it. One-shot `runTask` is the
shape that actually ports.

## What this repo would give up in cross-host mode

- Live steering mid-run.
- Session reuse across turns.
- Pi's event-level progress granularity, replaced by `onLive` ticks.
- The entire TUI. Confirmed unavoidable: taskflow's `render.ts`,
  `runs-view.ts`, `approval-view.ts` live only in `pi-taskflow`. Claude, Codex,
  OpenCode and Grok get MCP tools plus a routing skill and nothing else. On
  those hosts our dashboard, `ModelSelectorComponent`, checkpoint UI and slash
  commands cannot exist. Not a missing API to wait for.

Non-Pi tool exposure is MCP, not a plugin tool API. taskflow's Claude plugin is
`plugin.json` + `.mcp.json` (`npx -y -p claude-taskflow@0.2.6
claude-taskflow-mcp`) + skills markdown.

## What survives untouched

Replay identity is structural, not host-derived: `structuralPath + callSite +
occurrence` (`execution.ts:100-141`). Host session IDs only namespace the run
directory (`persistence.ts:54`). A transport swap does not disturb the replay
engine, which was the main risk the first pass flagged and could not settle.

Portable today: `execution.ts` (561), `persistence.ts` (854), `budget.ts`,
`utils.ts`, `workflow-artifacts.ts` (251). ~1,666 LOC strict, ~2,285 (21%)
including `registry.ts` and `doctor-cleanup.ts`, which inherit `.pi` path
conventions. `validation.ts` is deterministic but imports Pi frontmatter
parsing and hardcodes `.pi`.

## Problems the host research missed, that taskflow hit in production

- **Usage accounting is not universal.** Hence the `usageAccounting` field:
  Codex is `tokens-only`, Grok is `unavailable`. `unavailable` makes budget
  declarations fail closed at every execution boundary rather than silently
  pass. Our `budget.ts` currently assumes authoritative cost everywhere.
- **Permission models do not map.** Codex has an OS-level read-only sandbox;
  Claude in `-p` mode has none, so a tool is whitelisted or denied. Their fix:
  explicit read-only allowlist, mutating tools fail closed behind
  `PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1`, unknown tool names always fail closed.
  Our `disabledAgentResources` glob model has no equivalent on any host.
- **Env leakage across host boundaries.** `child-env.ts` plus per-host key
  allowlists, so a Claude child never sees `OPENAI_API_KEY`.
- **Background runs are entirely yours to build.** No host provides them.
  taskflow spawns a detached `process.execPath runnerScript tmpFile`, owns the
  state file, and cleans up with `killProcessTree`
  (`pi-taskflow/src/index.ts:1366-1521`). Their
  `docs/background-run-research.md` prices Claude Code's own implementation:
  separate supervisor daemon, worktree isolation, state on disk, restart
  recovery, quota isolation. Verdict there: heavy infrastructure, not a small
  feature. No host lets a plugin push a follow-up message into the main
  conversation on completion, so background completion is poll-or-notify only.

## The refactor, if pursued

1. Extract a `SubagentRunner`-shaped port from
   `agent-execution.ts:151-205`, where `createLocalPiSession` welds in
   `ModelRuntime`, `SettingsManager`, `DefaultPackageManager`,
   `DefaultResourceLoader`, `SessionManager`, `createAgentSession`. The
   scheduler above it is already portable.
2. Split `host.ts` (3,249 LOC): orchestration out of the Pi extension shell,
   TUI and slash commands stay Pi-only.
3. Replace `.pi` settings / trust / aliases / role discovery in `cli.ts`,
   `doctor.ts`, `validation.ts`.
4. Replace Pi JSONL transcript parsing in `session-inspector.ts` and
   `workflow-evals.ts`.
5. Rewrite `writePortableWorkflowBundle`. The existing bundle seam looks like a
   shortcut and is not: `bundles.ts` resolves the `pi` executable (`:53`,
   `:84`), imports `pi-coding-agent` (`:96-97`), reads `PI_CODING_AGENT_DIR`
   (`:143`). Reuse the serialization concepts, not the runner.

Cheapest first target is still OpenCode, now for a different reason: not
because its plugin API is richest, but because `opencode run --format json`
is a clean transport and the plugin can be trusted TypeScript.

## Prior art, and the question it raises

taskflow's `docs/internal/PI-ECOSYSTEM.md:118` profiles
`@zhushanwen/pi-workflow` 0.2.2 as "0 deps + `agent()/parallel()/pipeline()` JS
DSL + real cross-session resume + call cache, closest in spirit, threat: med."
That is this package's API surface under a different name. Worth establishing
whether it is a republish or a parallel invention before publishing anything
that compares against it.

Same file, line 128, asks: "DSL vs scripts, is JSON DSL the defensible
differentiator, or should we also offer a script mode?" They answered by adding
`taskflow-dsl`, a compile-time TypeScript layer that emits JSON. Hosts never
interpret TypeScript. Our bet is still distinct: they compile the script away,
we execute it deterministically and replay it.

## Open questions

- Can an OpenCode server plugin create child sessions against its own server,
  and how do parent IDs, tool permissions, cancellation and concurrent prompts
  behave?
- Do budget semantics degrade acceptably under `tokens-only` and `unavailable`
  accounting, or does a large part of `budget.ts` become Pi-only?
- Does `withWorktree` survive when agents are subprocesses that each need their
  own cwd, and does it still compose with a host's own worktree handling?
- Is Bun acceptable for the OpenCode plugin, or does the adapter need a Node
  worker?
- Host research snapshots are 2026-07-27 and these systems move fast.
  Revalidate before committing, especially Codex app-server dynamic tools,
  which were experimental.
