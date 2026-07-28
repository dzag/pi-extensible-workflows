/**
 * Hostile CLI Wrapper Pattern
 *
 * "Hostile CLI" is not a formal term: here it means any command-line tool that
 * is unsafe to consume programmatically because it behaves non-deterministically.
 * It may work fine when a human runs it by hand, yet break an automated workflow
 * because a subagent cannot trust its stdout or its exit code.
 *
 * Typical traits:
 *   - hangs or waits on interactive prompts instead of exiting;
 *   - prints logos, deprecation warnings, or progress noise into stdout;
 *   - exits 0 on failure (or non-zero with an empty stdout), so the exit code lies;
 *   - emits human-formatted text where a workflow expects machine-readable JSON.
 *
 * Well-known real-world offenders:
 *   - `apt-get install` hangs on the interactive `tzdata` prompt unless you set
 *     DEBIAN_FRONTEND=noninteractive (same spirit as CI=true below);
 *   - `npm install` mixes progress bars, `npm warn deprecated` and funding
 *     messages into stdout, corrupting any structured read;
 *   - `npm audit` exits non-zero when it finds vulnerabilities, breaking CI even
 *     though the install itself succeeded (an exit code that "lies" the other way);
 *   - `pip install` injects `WARNING: You are using pip version ...` into output;
 *   - `git clone` / `git push` block waiting for credentials instead of failing;
 *   - `docker pull` animates progress bars that pollute stdout.
 *
 * Cases seen while running massive cross-platform installs in Wizard-AI
 * (https://github.com/darkrei08/Wizard-AI) via a `wz-ai os install` layer:
 *   1. Hanging installs - an `apt` waiting on an interactive prompt froze an
 *      entire batch of tool installs; the subagent stayed alive with no error.
 *   2. JSON broken by warnings - parsing `pip`/`npm` output as JSON exploded
 *      because the tool prepended a banner or a deprecation warning.
 *   3. Lying exit codes - installs "succeeding" with exit 0 while silently
 *      skipping half the packages; the agent marched on and crashed far away.
 *
 * This wrapper normalizes such tools into deterministic, structured JSON so they
 * can feed the deterministic workflows described in the project docs:
 * https://vekexasia.github.io/pi-extensible-workflows/
 */
const { spawnSync } = require('child_process');

function runHostileCli(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: options.timeout || 30000, // Hard limit to prevent hanging workflows
    env: { ...process.env, CI: 'true' } // Disable interactive prompts
  });

  // 1. Handle actual process execution errors or timeouts
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') return { status: 'error', reason: 'timeout' };
    return { status: 'error', reason: result.error.message };
  }

  // 2. Handle deceptive exits (e.g., exit 0 but logged to stderr, or exit != 0 with no stdout)
  if (result.status !== 0 && !result.stdout) {
    return { status: 'failed', stderr: result.stderr };
  }

  // 3. Force output into clean JSON (bypassing deprecation warnings or verbose text)
  try {
    const rawOut = (result.stdout || '').trim();
    // Example: Strip anything before the first '{' if the CLI prints ASCII logos or warnings
    const jsonStart = rawOut.indexOf('{');
    const cleanJson = jsonStart >= 0 ? rawOut.substring(jsonStart) : rawOut;
    
    return { status: 'success', data: JSON.parse(cleanJson) };
  } catch (e) {
    return { status: 'dirty_output', raw: result.stdout };
  }
}

module.exports = runHostileCli;
