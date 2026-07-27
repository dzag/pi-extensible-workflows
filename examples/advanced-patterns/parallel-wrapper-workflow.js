/**
 * Using the Hostile CLI Wrapper in a parallel workflow
 * 
 * This workflow demonstrates fanning out a wrapper script to parse multiple
 * modules deterministically, before handing the clean data to the LLM.
 */

const runHostileCli = require('./hostile-cli-wrapper.js');

module.exports = function() {
  // Step 1: Execute the wrapper locally (synchronously) to gather clean deterministic data
  // without wasting LLM context on error logs or CLI formatting.
  const frontendData = runHostileCli('my-hostile-cli', ['analyze', './src/frontend', '--json']);
  const backendData = runHostileCli('my-hostile-cli', ['analyze', './src/backend', '--json']);

  // Step 2: Pass the cleanly parsed, safe JSON to parallel subagents
  const { docFront, docBack } = parallel("document-modules", {
    docFront: agent(`Document the frontend based on this strict structural data: ${JSON.stringify(frontendData)}`, { role: "developer" }),
    docBack: agent(`Document the backend based on this strict structural data: ${JSON.stringify(backendData)}`, { role: "developer" })
  });

  // Step 3: Summarize
  return agent(`Merge the frontend and backend documentation:\n\nFrontend:\n${docFront}\n\nBackend:\n${docBack}`, { role: "reviewer" });
};
