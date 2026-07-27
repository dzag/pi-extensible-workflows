/**
 * Auto-Model Router for pi-extensible-workflows
 * 
 * Automatically detects available AI models and quotas (e.g., via Cockpit Tools or similar external quota managers)
 * and dynamically updates `settings.json` with the best available model for each role (developer, reviewer, scout, etc.).
 * 
 * This ensures deterministic workflows never fail due to hardcoded, out-of-quota, or deprecated models.
 */

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

// Path to your external quota/auth manager script (e.g., Cockpit Tools)
const COCKPIT_CLI = process.env.COCKPIT_CLI_PATH || path.join(os.homedir(), '.cockpit/scripts/cockpit-reader.mjs');
const SETTINGS_PATH = process.env.PI_WORKFLOWS_SETTINGS || path.join(os.homedir(), '.pi/agent/pi-extensible-workflows/settings.json');

try {
  // 1. Fetch live quotas and available models
  const out = execSync(`node "${COCKPIT_CLI}" status`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  const data = JSON.parse(out);

  // 2. Filter available models with > 0% quota
  const availableModels = data.models
    .filter(m => m.percentage > 0)
    .map(m => m.name);

  if (availableModels.length === 0) {
    console.error("No available models with quota.");
    process.exit(1);
  }

  // 3. Categorize by capabilities/effort (Example for Gemini/Claude)
  const tier1 = availableModels.filter(m => m.includes('pro') || m.includes('agent') || m.includes('sonnet') || m.includes('opus'));
  const tier2 = availableModels.filter(m => m.includes('flash') && !m.includes('lite') && !m.includes('low') && !m.includes('extra'));
  const tier3 = availableModels.filter(m => m.includes('lite') || m.includes('low') || m.includes('haiku'));

  const bestCode = tier1[0] || tier2[0] || availableModels[0];
  const bestReview = tier1.find(m => m.includes('agent') || m.includes('opus')) || bestCode;
  const bestMid = tier2[0] || bestCode;
  const bestFast = tier3[0] || tier2[0] || availableModels[0];

  // 4. Update the pi-extensible-workflows settings.json
  const settings = fs.existsSync(SETTINGS_PATH) ? JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) : { modelAliases: {} };
  
  // Use 'antigravity' or your preferred proxy provider prefix
  const provider = "antigravity"; 

  settings.modelAliases = {
    ...settings.modelAliases,
    "reviewer-model": `${provider}/${bestReview}`,
    "scout-model": `${provider}/${bestFast}`,
    "cheap-model": `${provider}/${bestFast}`,
    "developer-model": `${provider}/${bestCode}`,
    "fast": `${provider}/${bestFast}`,
    "smart": `${provider}/${bestCode}`,
    "deep": `${provider}/${bestReview}`,
    "planner-model": `${provider}/${bestCode}`,
    "security-model": `${provider}/${bestReview}`,
    "designer-model": `${provider}/${bestMid}`
  };

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log("pi-extensible-workflows successfully routed to active models:");
  console.log(JSON.stringify(settings.modelAliases, null, 2));

} catch (err) {
  console.error("Failed to dynamically route models:", err.message);
}
