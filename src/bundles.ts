import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, WorkflowCatalogFunction } from "./types.js";

export interface PortableWorkflowManifest {
  format: "pi-extensible-workflows-bundle";
  version: 1;
  command: string;
  workflow: { name: string; description: string; input: Record<string, unknown>; output: Record<string, unknown> };
  runtime: { pi: string; "pi-extensible-workflows": string };
  requirements: { roles: readonly string[]; aliases: readonly string[]; tools: readonly string[]; commands: readonly string[]; environment: readonly string[] };
}

export interface PortableWorkflowBundleInput {
  destination: string;
  command: string;
  workflow: WorkflowCatalogFunction;
  functionSource: string;
  piVersion?: string;
  engineVersion?: string;
  force?: boolean;
  requirements?: Partial<PortableWorkflowManifest["requirements"]>;
  roles?: Readonly<Record<string, AgentDefinition>>;
}

function packageJson(): Record<string, unknown> {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(directory, "../package.json"), join(directory, "../../package.json")]) {
    try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* Try the source and built layouts. */ }
  }
  return {};
}

export function portableEngineVersion(): string {
  const version = packageJson().version;
  return typeof version === "string" && version.trim() ? version : "unknown";
}

export function portablePiVersion(): string {
  const command = process.platform === "win32" ? "pi.cmd" : "pi";
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return "unknown";
  return result.stdout.trim().split(/\r?\n/, 1)[0] ?? "unknown";
}

function shellLauncher(): string {
  return "#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec node \"$ROOT/payload/runner.mjs\" \"$@\"\n";
}

function windowsLauncher(): string {
  return "@echo off\r\nnode \"%~dp0payload\\runner.mjs\" %*\r\n";
}

function runnerSource(): string {
  return [
    "import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';",
    "import { homedir } from 'node:os';",
    "import { delimiter, dirname, join, sep } from 'node:path';",
    "import { createInterface } from 'node:readline/promises';",
    "import { spawnSync } from 'node:child_process';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    "const bundleRoot = dirname(dirname(fileURLToPath(import.meta.url)));",
    "const manifest = JSON.parse(readFileSync(join(bundleRoot, 'manifest.json'), 'utf8'));",
    "function run(command, args) {",
    "  const result = spawnSync(command, args, { encoding: 'utf8' });",
    "  if (result.error) throw result.error;",
    "  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };",
    "}",
    "function piCommand() {",
    "  const names = process.platform === 'win32' ? ['pi.cmd', 'pi'] : ['pi'];",
    "  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {",
    "    for (const name of names) {",
    "      const candidate = join(entry, name);",
    "      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Continue searching PATH. */ }",
    "    }",
    "  }",
    "  throw new Error('Pi was not found on PATH. Install Pi through npm before running this bundle.');",
    "}",
    "function assertNpmPi(pi) {",
    "  const resolved = realpathSync(pi);",
    "  if (!resolved.includes(`${sep}node_modules${sep}`)) throw new Error('The pi executable is not an npm installation. Install Pi through npm and retry.');",
    "}",
    "function packageVersion(root) {",
    "  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return undefined; }",
    "}",
    "function listedEngine(pi) {",
    "  let result;",
    "  try { result = run(pi, ['list']); } catch { return undefined; }",
    "  if (result.status !== 0) return undefined;",
    "  const lines = result.stdout.split(/\\r?\\n/);",
    "  for (let index = 0; index < lines.length; index += 1) {",
    "    if (!/^\\s*npm:pi-extensible-workflows(?:@\\S+)?\\s*$/.test(lines[index])) continue;",
    "    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {",
    "      const candidate = lines[next].trim();",
    "      if ((candidate.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(candidate)) && existsSync(join(candidate, 'package.json'))) return candidate;",
    "    }",
    "  }",
    "  return undefined;",
    "}",
      "function engineCandidates(pi) {",
      "  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');",
      "  const listed = listedEngine(pi);",
      "  const roots = [listed, join(agentDir, 'npm', 'node_modules', 'pi-extensible-workflows')];",
      "  try { const globalRoot = run('npm', ['root', '-g']); if (globalRoot.status === 0) roots.push(join(globalRoot.stdout.trim(), 'pi-extensible-workflows')); } catch { /* npm is checked by Pi installation. */ }",
      "  return [...new Set(roots.filter((root) => typeof root === 'string' && existsSync(join(root, 'package.json'))))];",
      "}",
      "function findEngine(pi) {",
      "  for (const root of engineCandidates(pi)) {",
      "    const version = packageVersion(root);",
      "    if (typeof version === 'string') return { root: realpathSync(root), version };",
      "  }",
      "  return undefined;",
      "}",
      "async function confirmInstall(pi, expected) {",
      "  if (!(process.stdin.isTTY && process.stderr.isTTY)) throw new Error(`The compatible pi-extensible-workflows package is missing. Re-run '${manifest.command} setup --yes' to approve: ${pi} install npm:pi-extensible-workflows@${expected}`);",
      "  const prompt = createInterface({ input: process.stdin, output: process.stderr });",
      "  try { const answer = await prompt.question(`Install pi-extensible-workflows@${expected} through Pi now? [y/N] `); return /^y(es)?$/i.test(answer.trim()); } finally { prompt.close(); }",
      "}",
      "async function ensureEngine(pi, allowInstall, approve) {",
      "  const expected = manifest.runtime['pi-extensible-workflows'];",
      "  let engine = findEngine(pi);",
      "  if (engine?.version === expected) return engine;",
      "  if (!allowInstall) throw new Error(`Compatible pi-extensible-workflows@${expected} is not installed through Pi. Run '${manifest.command} setup' first; no installation is performed during launch.`);",
      "  if (!approve && !(await confirmInstall(pi, expected))) throw new Error('Installation was not approved.');",
      "  const result = run(pi, ['install', `npm:pi-extensible-workflows@${expected}`]);",
      "  if (result.status !== 0) throw new Error(`Pi could not install pi-extensible-workflows@${expected}: ${result.stderr.trim() || 'installation failed'}`);",
      "  engine = findEngine(pi);",
      "  if (engine?.version !== expected) throw new Error(`Pi installed an incompatible pi-extensible-workflows version; expected ${expected}.`);",
      "  return engine;",
      "}",
      "function checkRequirements() {",
      "  for (const command of manifest.requirements.commands) {",
      "    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });",
      "    if (result.error || result.status !== 0) throw new Error(`Missing required external command: ${command}`);",
      "  }",
      "  for (const name of manifest.requirements.environment) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);",
      "}",
      "function piVersion(pi) {",
      "  const result = run(pi, ['--version']);",
      "  return result.status === 0 ? result.stdout.trim().split(/\\r?\\n/, 1)[0] : 'unknown';",
      "}",
      "function assertPiVersion(pi) {",
      "  const expected = manifest.runtime.pi;",
      "  const actual = piVersion(pi);",
      "  if (expected !== 'unknown' && actual !== expected) throw new Error(`Bundle requires Pi ${expected}; found ${actual}.`);",
      "}",
      "async function setup(argv) {",
      "  if (argv.some((arg) => arg !== '--yes' && arg !== '--help' && arg !== '-h')) throw new Error('Usage: ' + manifest.command + ' setup [--yes]');",
      "  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: ' + manifest.command + ' setup [--yes]'); return; }",
      "  const approve = argv.includes('--yes');",
      "  const pi = piCommand();",
      "  assertNpmPi(pi);",
      "  assertPiVersion(pi);",
      "  const engine = await ensureEngine(pi, true, approve);",
      "  checkRequirements();",
      "  console.log('Bundle setup complete.');",
      "  console.log('Pi: ' + piVersion(pi));",
      "  console.log('pi-extensible-workflows: ' + engine.version);",
      "}",
      "async function launch(argv) {",
      "  const pi = piCommand();",
      "  assertNpmPi(pi);",
      "  assertPiVersion(pi);",
      "  const engine = await ensureEngine(pi, false, false);",
      "  checkRequirements();",
      "  const engineIndex = pathToFileURL(join(engine.root, 'dist', 'src', 'index.js')).href;",
      "  const payload = await import(pathToFileURL(join(bundleRoot, 'payload', 'workflow.mjs')).href + '?bundle=' + String(Date.now()));",
      "  const api = await import(engineIndex);",
      "  payload.register(api.registerWorkflowExtension);",
      "  const cli = await import(pathToFileURL(join(engine.root, 'dist', 'src', 'cli.js')).href);",
      "  return cli.runCli(['run', manifest.workflow.name, ...argv], { cwd: process.cwd(), stderr: (text) => process.stderr.write(text) });",
      "}",
      "const argv = process.argv.slice(2);",
      "try {",
      "  if (argv[0] === 'setup') await setup(argv.slice(1));",
      "  else process.exitCode = await launch(argv);",
      "} catch (error) {",
      "  console.error('Bundle error: ' + (error instanceof Error ? error.message : String(error)));",
      "  process.exitCode = 1;",
      "}",
  ].join("\n") + "\n";
}

function workflowModule(workflow: WorkflowCatalogFunction, functionSource: string, withRoles: boolean): string {
  const source = functionSource.trim();
  if (!source || source.includes("[native code]")) throw new Error(`Workflow ${workflow.name} cannot be exported because its function source is unavailable`);
  return [
    `const run = ${source};`,
    "export function register(registerWorkflowExtension) {",
    "  registerWorkflowExtension({",
    `    version: ${JSON.stringify("1.0.0")},`,
    `    headline: ${JSON.stringify("Portable workflow bundle")},`,
    `    description: ${JSON.stringify(workflow.description)},`,
    ...(withRoles ? [`    roleDirectories: [new URL("./roles", import.meta.url)],`] : []),
    "    functions: {",
    `      [${JSON.stringify(workflow.name)}]: {`,
    `        description: ${JSON.stringify(workflow.description)},`,
    `        input: ${JSON.stringify(workflow.input)},`,
    `        output: ${JSON.stringify(workflow.output)},`,
    "        run,",
    "      },",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

function roleMarkdown(role: AgentDefinition): string {
  const metadata = ["---"];
  if (role.description !== undefined) metadata.push(`description: ${JSON.stringify(role.description)}`);
  if (role.model !== undefined) metadata.push(`model: ${JSON.stringify(role.model)}`);
  if (role.thinking !== undefined) metadata.push(`thinking: ${JSON.stringify(role.thinking)}`);
  if (role.tools !== undefined) metadata.push(`tools: ${JSON.stringify(role.tools)}`);
  if (role.overrideSystemPrompt !== undefined) metadata.push(`overrideSystemPrompt: ${String(role.overrideSystemPrompt)}`);
  if (role.disabledAgentResources !== undefined) metadata.push(`disabledAgentResources: ${JSON.stringify(role.disabledAgentResources)}`);
  metadata.push("---");
  return `${metadata.join("\n")}\n${role.prompt ?? ""}\n`;
}

export function writePortableWorkflowBundle(input: PortableWorkflowBundleInput): PortableWorkflowManifest {
  const engineVersion = input.engineVersion ?? portableEngineVersion();
  const manifest: PortableWorkflowManifest = {
    format: "pi-extensible-workflows-bundle",
    version: 1,
    command: input.command,
    workflow: { name: input.workflow.name, description: input.workflow.description, input: input.workflow.input, output: input.workflow.output },
    runtime: { pi: input.piVersion ?? "unknown", "pi-extensible-workflows": engineVersion },
    requirements: {
      roles: input.requirements?.roles ?? Object.keys(input.roles ?? {}),
      aliases: input.requirements?.aliases ?? [],
      tools: input.requirements?.tools ?? [],
      commands: input.requirements?.commands ?? [],
      environment: input.requirements?.environment ?? [],
    },
  };
  const parent = dirname(input.destination);
  mkdirSync(parent, { recursive: true });
  if (existsSync(input.destination) && !input.force) throw new Error(`Destination already exists: ${input.destination}; use --force to replace it`);
  const temporary = mkdtempSync(join(parent, ".pi-extensible-workflows-bundle-"));
  try {
    const payload = join(temporary, "payload");
    mkdirSync(payload);
    const roles = input.roles ?? {};
    if (Object.keys(roles).length) {
      const roleDirectory = join(payload, "roles");
      mkdirSync(roleDirectory);
      for (const [name, role] of Object.entries(roles)) writeFileSync(join(roleDirectory, `${name}.md`), roleMarkdown(role), { encoding: "utf8", mode: 0o600 });
    }
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(payload, "workflow.mjs"), workflowModule(input.workflow, input.functionSource, Object.keys(roles).length > 0), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(payload, "runner.mjs"), runnerSource(), { encoding: "utf8", mode: 0o700 });
    const launcher = join(temporary, input.command);
    writeFileSync(launcher, shellLauncher(), { encoding: "utf8", mode: 0o755 });
    chmodSync(launcher, 0o755);
    writeFileSync(join(temporary, `${input.command}.cmd`), windowsLauncher(), { encoding: "utf8", mode: 0o644 });
    if (input.force) rmSync(input.destination, { recursive: true, force: true });
    renameSync(temporary, input.destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return manifest;
}