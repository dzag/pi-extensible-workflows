import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
  createHerdrAgentReporter,
  herdrAvailable,
  herdrCommandRunner,
  loadSettings,
  openHerdrLivePane,
  waitForHerdrPane,
  registerWorkflowExtension,
  workflowSettingsPath,
} from "pi-extensible-workflows";

function agentDir() { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }

function settings(agentDirectory = agentDir()) {
  try { return loadSettings(workflowSettingsPath(agentDirectory)); }
  catch { return {}; }
}

function herdrConfig(agentDirectory = agentDir()) {
  const extensions = settings(agentDirectory).extensions;
  return extensions && !Array.isArray(extensions) && extensions.herdr ? extensions.herdr : {};
}

export function isFullyInspectableMode(agentDirectory = agentDir()) { return herdrConfig(agentDirectory).enableFullyInspectableMode === true; }

export function breadcrumbLabel(identity, attempt = 1) {
  const parts = [
    ...(identity.structuralPath ?? []),
    ...(identity.parentBreadcrumb ? [identity.parentBreadcrumb] : []),
    ...(identity.worktreeOwner ? [`worktree:${identity.worktreeOwner}`] : []),
    identity.callSite,
  ].filter((part) => typeof part === "string" && part.trim());
  return `${parts.join(" > ")} #${String(attempt)}`;
}

function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function hasToolCall(message) { return Array.isArray(message?.content) && message.content.some((part) => part && typeof part === "object" && part.type === "toolCall"); }
function needsContinuation(message) { return !message || message.stopReason === "aborted" || hasToolCall(message); }
function createCommandFiles(prepared, prompt, directPrompt) {
  const paths = [];
  const create = (kind, value) => {
    const path = join(tmpdir(), `pi-herdr-${kind}-${String(process.pid)}-${randomBytes(6).toString("hex")}.txt`);
    writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
    paths.push(path);
    return path;
  };
  const files = {
    systemPrompt: prepared.systemPrompt === undefined ? undefined : create("system-prompt", prepared.systemPrompt),
    appendPrompt: prepared.systemPromptAppend ? create("append-prompt", prepared.systemPromptAppend) : undefined,
    prompt: prompt === undefined || directPrompt ? undefined : create("prompt", prompt),
  };
  return { ...files, command(value) { return `sh ${quote(create("command", `${value}\n`))}`; }, async close() { for (const path of paths) { try { unlinkSync(path); } catch { /* Cleanup is best effort after the child exits. */ } } } };
}
function resourcePaths(session) {
  const value = session?.getHerdrResourcePaths?.();
  if (!value || typeof value !== "object") return { extensions: [], skills: [] };
  return {
    extensions: Array.isArray(value.extensions) ? value.extensions.filter((path) => typeof path === "string") : [],
    skills: Array.isArray(value.skills) ? value.skills.filter((path) => typeof path === "string") : [],
  };
}
function sessionPath(reference) {
  const locator = reference?.locator;
  return locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : undefined;
}
function inlineFactorySource(extension) {
  const factory = typeof extension === "function" ? extension : extension && typeof extension === "object" && typeof extension.factory === "function" ? extension.factory : undefined;
  if (!factory) throw new Error("Herdr live sessions cannot transfer an invalid inline extension factory.");
  const source = Function.prototype.toString.call(factory);
  if (source.includes("[native code]")) throw new Error("Herdr live sessions cannot transfer a native inline extension factory.");
  return source;
}
function createInlineExtensionBridge(prepared) {
  const factories = prepared.extensionFactories ?? [];
  if (!factories.length) return undefined;
  const extensionPath = join(tmpdir(), `pi-herdr-extensions-${String(process.pid)}-${randomBytes(6).toString("hex")}.mjs`);
  const source = `const factories = [${factories.map(inlineFactorySource).join(",")}];\nexport default async function(pi) { for (const factory of factories) await factory(pi); }\n`;
  writeFileSync(extensionPath, source, { encoding: "utf8", mode: 0o600 });
  return { extensionPath, async close() { try { unlinkSync(extensionPath); } catch { /* Cleanup is best effort after the child exits. */ } } };
}
async function createToolBridge(prepared) {
  const definitions = [...(prepared.customTools ?? []), ...(prepared.resultTool ? [prepared.resultTool] : [])];
  if (!definitions.length) return undefined;
  const specs = definitions.map(({ name, label, description, promptSnippet, promptGuidelines, parameters, renderShell, executionMode }) => ({ name, label, description, ...(promptSnippet === undefined ? {} : { promptSnippet }), ...(promptGuidelines === undefined ? {} : { promptGuidelines }), parameters, ...(renderShell === undefined ? {} : { renderShell }), ...(executionMode === undefined ? {} : { executionMode }) }));
  const socketPath = join(tmpdir(), `pi-herdr-tools-${String(process.pid)}-${randomBytes(6).toString("hex")}.sock`);
  const extensionPath = join(tmpdir(), `pi-herdr-tools-${String(process.pid)}-${randomBytes(6).toString("hex")}.mjs`);
  const source = `import net from "node:net";\nconst socketPath = ${JSON.stringify(socketPath)};\nconst tools = ${JSON.stringify(specs)};\nfunction callTool(toolCallId, name, params, signal, onUpdate) {\n  return new Promise((resolve, reject) => {\n    const socket = net.createConnection(socketPath);\n    let buffer = "";\n    let settled = false;\n    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); socket.destroy(); error ? reject(error) : resolve(value); };\n    const abort = () => finish(new Error("Herdr tool call aborted"));\n    socket.setEncoding("utf8");\n    socket.on("connect", () => socket.write(JSON.stringify({ toolCallId, name, params }) + "\\n"));\n    socket.on("data", (chunk) => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch { continue; } if (message.type === "update") onUpdate?.(message.value); else if (message.type === "error") finish(new Error(message.error)); else if (message.type === "result") finish(undefined, message.value); } });\n    socket.on("error", (error) => finish(error));\n    socket.on("close", () => finish(new Error("Herdr tool bridge closed")));\n    signal?.addEventListener("abort", abort, { once: true });\n  });\n}\nexport default function(pi) { for (const tool of tools) pi.registerTool({ ...tool, async execute(toolCallId, params, signal, onUpdate) { return callTool(toolCallId, tool.name, params, signal, onUpdate); } }); }\n`;
  writeFileSync(extensionPath, source, { encoding: "utf8", mode: 0o600 });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let buffer = "";
    let handled = false;
    const send = (message) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
    const handle = async (request) => {
      if (handled) return;
      handled = true;
      const definition = definitions.find(({ name }) => name === request.name);
      if (!definition) { send({ type: "error", error: `Unknown Herdr tool: ${request.name}` }); return; }
      try {
        const value = await definition.execute(request.toolCallId, request.params, controller.signal, (update) => send({ type: "update", value: update }), undefined);
        send({ type: "result", value });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; try { void handle(JSON.parse(line)); } catch (error) { send({ type: "error", error: error instanceof Error ? error.message : String(error) }); } } });
    socket.on("close", () => { controller.abort(); sockets.delete(socket); });
    socket.on("error", () => { controller.abort(); sockets.delete(socket); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); }); });
  let closed = false;
  return { extensionPath, async close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    try { unlinkSync(extensionPath); } catch { /* Cleanup is best effort after the child exits. */ }
    try { unlinkSync(socketPath); } catch { /* Cleanup is best effort after the child exits. */ }
  } };
}

function sessionCommand(session, prepared, prompt, bridges, files, directPrompt) {
  const source = sessionPath(session.reference);
  const sessionArg = source ? `--session ${quote(source)}` : `--session-id ${quote(session.reference.sessionId)}`;
  const model = `${prepared.model.provider}/${prepared.model.model}${prepared.model.thinking ? `:${prepared.model.thinking}` : ""}`;
  const toolNames = [...new Set([...prepared.tools, ...(prepared.customTools ?? []).map(({ name }) => name), ...(prepared.resultTool ? [prepared.resultTool.name] : [])])];
  const tools = toolNames.length ? ` --tools ${quote(toolNames.join(","))}` : " --no-tools";
  const systemPrompt = prepared.systemPrompt !== undefined ? ` --system-prompt ${quote(files.systemPrompt)}` : prepared.systemPromptPath ? ` --system-prompt ${quote(prepared.systemPromptPath)}` : "";
  const appendPrompt = files.appendPrompt ? ` --append-system-prompt ${quote(files.appendPrompt)}` : "";
  const loaded = resourcePaths(session);
  const allowedSkills = [...new Set([...(prepared.additionalSkillPaths ?? []), ...loaded.skills])];
  const skills = prepared.resourcePolicy ? ` --no-skills${allowedSkills.map((path) => ` --skill ${quote(path)}`).join("")}` : allowedSkills.map((path) => ` --skill ${quote(path)}`).join("");
  const allowedExtensions = [...new Set(loaded.extensions)];
  const bridgeExtensions = bridges.filter(Boolean).map(({ extensionPath }) => ` --extension ${quote(extensionPath)}`).join("");
  const extensions = prepared.resourcePolicy ? ` --no-extensions${allowedExtensions.map((path) => ` --extension ${quote(path)}`).join("")}${bridgeExtensions}` : bridgeExtensions;
  const trust = prepared.resourcePolicy?.projectTrusted === false ? " --no-approve" : prepared.resourcePolicy?.projectTrusted === true ? " --approve" : "";
  const environment = [prepared.agentDir ? `PI_CODING_AGENT_DIR=${quote(prepared.agentDir)}` : "", "PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER=1"].filter(Boolean).join(" ");
  const message = prompt === undefined ? "" : directPrompt ? ` ${quote(prompt)}` : ` @${quote(files.prompt)}`;
  return `${environment} pi ${sessionArg} --model ${quote(model)}${tools}${systemPrompt}${appendPrompt}${skills}${extensions}${trust}${message}`;
}

function paneId(value) { return typeof value === "string" ? value : value.paneId; }

function createWorkflowWorkspaces(runner) {
  const workspaces = new Map();
  return {
    async open(run, request) {
      const existing = workspaces.get(run.runId);
      if (existing) return openHerdrLivePane({ ...request, workspaceId: await existing }, runner);
      const opening = openHerdrLivePane({ ...request, workspaceLabel: `workflow ${run.workflow.name}` }, runner);
      const workspace = opening.then((pane) => {
        if (typeof pane === "string") throw new Error("Herdr did not create a workspace pane.");
        return pane.workspaceId;
      });
      workspaces.set(run.runId, workspace);
      try { return await opening; } catch (error) { workspaces.delete(run.runId); throw error; }
    },
    async close(runId) {
      const workspace = workspaces.get(runId);
      workspaces.delete(runId);
      if (workspace) await workspace.then((id) => runner(["workspace", "close", id])).catch(() => undefined);
    },
    async closeAll() { await Promise.all([...workspaces.keys()].map((runId) => this.close(runId))); },
  };
}

async function launchPane({ session, prepared, identity, run, attempt, runner, fullyInspectable, env, signal, prompt, workspaces, tuiIndex, tuiLabel, directPrompt = false, onStatus }) {
  const label = fullyInspectable && Number.isInteger(tuiIndex) && tuiIndex > 0 && typeof tuiLabel === "string" && tuiLabel.trim() ? `#${String(tuiIndex)} ${tuiLabel}` : fullyInspectable ? breadcrumbLabel(identity, attempt) : prepared.sessionLabel;
  const bridge = await createToolBridge(prepared);
  let inlineBridge;
  let commandFiles;
  let pane;
  try {
    inlineBridge = createInlineExtensionBridge(prepared);
    commandFiles = createCommandFiles(prepared, prompt, directPrompt);
    const bridges = [bridge, inlineBridge].filter(Boolean);
    const command = commandFiles.command(sessionCommand(session, prepared, prompt, bridges, commandFiles, directPrompt));
    const opened = fullyInspectable
      ? await workspaces.open(run, { cwd: prepared.cwd, tabLabel: label, command })
      : await openHerdrLivePane({ action: "live", cwd: prepared.cwd, command, paneId: env?.HERDR_PANE_ID }, runner);
    pane = paneId(opened);
    let remoteClosed = false;
    const closeRemote = async () => {
      if (remoteClosed) return;
      remoteClosed = true;
      await runner(fullyInspectable && typeof opened !== "string" ? ["tab", "close", opened.tabId] : ["pane", "close", pane]).catch(() => undefined);
    };
    const reporter = createHerdrAgentReporter(pane, label, runner);
    const reference = session.reference;
    const sessionRef = { sessionId: reference.sessionId, ...(sessionPath(reference) ? { sessionPath: sessionPath(reference) } : {}) };
    try {
      await reporter.reportSession(sessionRef, "workflow-agent");
    } catch (error) {
      await closeRemote();
      throw error;
    }
    const monitor = waitForHerdrPane(pane, runner, { signal, ...(onStatus ? { onStatus } : {}) }).then(async (reason) => {
      await closeRemote();
      await reporter.release();
      await bridge?.close();
      await inlineBridge?.close();
      await commandFiles?.close();
      return reason;
    }).catch(async (error) => {
      await closeRemote();
      await reporter.release().catch(() => undefined);
      await bridge?.close();
      await inlineBridge?.close();
      await commandFiles?.close();
      throw error;
    });
    return { pane, monitor, reporter, closeRemote, close: async () => { await bridge?.close(); await inlineBridge?.close(); await commandFiles?.close(); } };
  } catch (error) {
    if (pane && !fullyInspectable) await runner(["pane", "close", pane]).catch(() => undefined);
    await bridge?.close();
    await inlineBridge?.close();
    await commandFiles?.close();
    throw error;
  }
}

function herdrTransport(agent, context, runner, fullyInspectable, env, workspaces) {
  const local = agent.transport;
  return {
    id: "herdr",
    async createSession(prepared, sessionContext) {
      const session = await local.createSession(prepared, sessionContext);
      let opened;
      try {
        await session.suspendForHandoff?.();
        if (!session.suspendForHandoff) await session.abort?.();
        opened = await launchPane({ session, prepared, identity: context.identity, run: context.run, attempt: sessionContext.attempt, runner, fullyInspectable, env, signal: sessionContext.signal, prompt: prepared.initialPrompt, workspaces, tuiIndex: context.tuiIndex, tuiLabel: context.tuiLabel });
      } catch (error) {
        await session.dispose();
        throw error;
      }
      let disposed = false;
      let active = opened;
      return {
        ...session,
        reference: { ...session.reference, transport: "herdr" },
        async prompt(text) {
          if (disposed) throw new Error("Herdr workflow session is disposed");
          let current = active;
          if (!current) {
            await session.suspendForHandoff?.();
            current = await launchPane({ session, prepared, identity: context.identity, run: context.run, attempt: sessionContext.attempt, runner, fullyInspectable, env, signal: sessionContext.signal, prompt: text, workspaces, tuiIndex: context.tuiIndex, tuiLabel: context.tuiLabel });
          }
          active = current;
          try {
            await current.monitor;
          } finally {
            await session.resumeFromHandoff?.();
            if (active === current) active = undefined;
          }
          let assistant = session.getLastAssistant?.();
          const resultSubmitted = prepared.resultTool && Array.isArray(assistant?.content) && assistant.content.some((part) => part && typeof part === "object" && part.type === "toolCall" && part.name === prepared.resultTool.name);
          const incomplete = needsContinuation(assistant);
          if (!resultSubmitted && incomplete) {
            await session.prompt("Continue the task from the current session state.");
            assistant = session.getLastAssistant?.();
          }
          return assistant ? { assistant } : {};
        },
        async abort() { await session.abort(); },
        async dispose() {
          if (disposed) return;
          disposed = true;
          if (active) {
            await active.closeRemote?.();
            await active.close?.();
          }
          await session.dispose();
        }
      };
    },
  };
}

function registerLifecycleHooks(pi, runner, env) {
  const pane = env.HERDR_PANE_ID;
  if (env.PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER !== "1" || !pane || typeof pi?.on !== "function" || typeof pi?.events?.on !== "function") return;
  const reporter = createHerdrAgentReporter(pane, "pi", runner);
  let sessionRef = {};
  let rootSession = false;
  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage;
  let lastState;
  let lastMessage;
  let queuedState;
  let stateReport = Promise.resolve();
  const refresh = (ctx) => {
    const path = ctx?.sessionManager?.getSessionFile?.();
    const id = ctx?.sessionManager?.getSessionId?.();
    sessionRef = { ...(typeof id === "string" ? { sessionId: id } : {}), ...(typeof path === "string" ? { sessionPath: path } : {}) };
    return sessionRef;
  };
  const desiredState = () => blockedCount > 0 ? { state: "blocked", message: blockedMessage } : agentActive ? { state: "working", message: undefined } : { state: "idle", message: undefined };
  const drainState = async () => {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await reporter.reportState(next.state, next.message, sessionRef);
    }
  };
  const publishState = (force = false) => {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queuedState = next;
    stateReport = stateReport.then(drainState, drainState);
  };
  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    if (!data?.active) { blockedCount = Math.max(0, blockedCount - 1); if (blockedCount === 0) blockedMessage = undefined; }
    else { blockedCount += 1; blockedMessage = data.label; }
    publishState();
  });
  pi.on("session_start", async (event, ctx) => {
    rootSession = true;
    refresh(ctx);
    await reporter.reportSession(sessionRef, event?.reason);
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
    await stateReport;
  });
  pi.on("agent_start", async (_event, ctx) => {
    if (!rootSession) return;
    refresh(ctx);
    await reporter.reportSession(sessionRef);
    agentActive = true;
    publishState();
    await stateReport;
  });
  pi.on("turn_end", async (event) => {
    if (!rootSession) return;
    const toolCalls = Array.isArray(event?.message?.content) && event.message.content.filter((part) => part && typeof part === "object" && part.type === "toolCall");
    agentActive = Boolean(toolCalls?.length) && !toolCalls.some((part) => part.name === "workflow_result");
    publishState();
    await stateReport;
  });
  pi.on("agent_settled", async () => { if (!rootSession) return; agentActive = false; publishState(); await stateReport; });
  pi.on("agent_end", async (_event, ctx) => { if (!rootSession || ctx?.isIdle?.() !== true) return; agentActive = false; publishState(); await stateReport; });
  pi.on("session_shutdown", (event) => event?.reason === "quit" ? reporter.release() : undefined);
}

export function createHerdrExtension(options = {}) {
  const env = options.env ?? process.env;
  const runner = options.runner ?? herdrCommandRunner;
  const workspaces = options.workspaces ?? createWorkflowWorkspaces(runner);
  const fullyInspectable = isFullyInspectableMode(options.agentDir);
  return {
    version: "1.0.0",
    headline: "Herdr workflow integration",
    description: "Open and inspect live workflow agents in Herdr panes.",
    agentAttemptActions: {
      openLiveSession: {
        label: "Open live session in Herdr pane",
        visible(context) { return herdrAvailable(env) && !fullyInspectable && Boolean(context.liveSession && context.prepared && context.handoff); },
        async run(context) {
          const session = context.liveSession;
          const prepared = context.prepared;
          const handoff = context.handoff;
          if (!session || !prepared || !handoff) return;
          const label = typeof context.agent.label === "string" && context.agent.label.trim() ? context.agent.label : typeof context.agent.name === "string" && context.agent.name.trim() ? context.agent.name : "workflow agent";
          const setWorkingMessage = (state) => context.ui.setWorkingMessage?.(state ? `${label}: ${state}` : undefined);
          await handoff.request(async () => {
            if (!needsContinuation(session.getLastAssistant?.())) return;
            let opened;
            let suspended = false;
            let reportedWorking = false;
            let lastState = "working";
            let displayedState;
            const reportStatus = (state) => {
              lastState = state;
              if (state === "working") reportedWorking = true;
              if (displayedState !== state) {
                displayedState = state;
                setWorkingMessage(state);
              }
            };
            try {
              if (session.suspendForHandoff) {
                await session.suspendForHandoff();
                suspended = true;
              }
              opened = await launchPane({ session, prepared, identity: { structuralPath: context.agent.structuralPath ?? [], parentBreadcrumb: context.agent.parentBreadcrumb, callSite: context.agent.label ?? context.agent.name, occurrence: context.attempt.attempt }, attempt: context.attempt.attempt, runner, fullyInspectable: false, env, signal: context.signal, prompt: "Continue the current workflow task from this session.", directPrompt: true, onStatus: reportStatus });
              handoff.takeover();
              if (!session.suspendForHandoff) {
                await session.abort?.();
                suspended = true;
              }
              if (displayedState === undefined || lastState === "idle") {
                displayedState = "working";
                setWorkingMessage("working");
                reportedWorking = true;
              }
              await opened.monitor;
            } finally {
              try {
                if (reportedWorking) setWorkingMessage(lastState === "done" ? "completed" : "idle");
              } finally {
                try {
                  if (suspended) await session.resumeFromHandoff?.();
                } finally {
                  if (reportedWorking) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    setWorkingMessage();
                  }
                }
              }
            }
          });
        },
      },
    },
    agentSetupHooks: {
      fullyInspectable: {
        setup(agent, context) {
          if (!fullyInspectable || !herdrAvailable(env)) return;
          agent.transport = herdrTransport(agent, context, runner, true, env, workspaces);
        },
      },
    },
  };
}

export function registerHerdrExtension(options = {}) {
  const env = options.env ?? process.env;
  if (!herdrAvailable(env)) return false;
  registerWorkflowExtension(createHerdrExtension(options));
  return true;
}

function registerWorkspaceLifecycle(pi, workspaces) {
  if (typeof pi?.events?.on !== "function") return;
  pi.events.on(WORKFLOW_RUN_COMPLETED_EVENT, (event) => workspaces.close(event?.runId));
  pi.events.on(WORKFLOW_RUN_STATE_CHANGED_EVENT, (event) => ["failed", "stopped", "interrupted", "budget_exhausted"].includes(event?.state) ? workspaces.close(event.runId) : undefined);
  pi.on("session_shutdown", () => workspaces.closeAll());
}

export default function extension(pi, overrides = {}) {
  const runner = overrides.runner ?? herdrCommandRunner;
  const workspaces = overrides.workspaces ?? createWorkflowWorkspaces(runner);
  const options = { env: overrides.env ?? process.env, runner, workspaces };
  if (registerHerdrExtension(options)) {
    registerLifecycleHooks(pi, runner, options.env);
    registerWorkspaceLifecycle(pi, workspaces);
  }
}
