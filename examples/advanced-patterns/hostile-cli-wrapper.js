/**
 * Hostile CLI Wrapper Pattern
 *
 * "Hostile CLI" is not a formal term: here it means any command-line tool that
 * is unsafe to consume programmatically because it behaves non-deterministically.
 * Typical traits:
 *   - hangs or waits on interactive prompts instead of exiting;
 *   - prints logos, deprecation warnings, or progress noise into stdout;
 *   - exits 0 on failure (or non-zero with an empty stdout), so the exit code lies;
 *   - emits human-formatted text where a workflow expects machine-readable JSON.
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
