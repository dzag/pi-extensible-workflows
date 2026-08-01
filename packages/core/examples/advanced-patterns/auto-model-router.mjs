/**
 * Dynamic Model Router (extension pattern)
 *
 * Instead of mutating `settings.json` on disk, this registers trusted dynamic
 * `modelAliases`. Each alias exposes a `resolve(context)` that runs once per
 * launch (before preflight/availability checks) and picks the best model from
 * the live `context.availableModels` inventory.
 *
 * This keeps deterministic workflows from failing on hardcoded, out-of-quota,
 * or deprecated models, while staying inside the documented extension API:
 * https://vekexasia.github.io/pi-extensible-workflows/extensions.html#model-aliases
 *
 * Static aliases in global/project settings still override these package
 * defaults, so operators keep the final say.
 *
 * Load it from a Pi extension location, e.g. `~/.pi/agent/extensions/`.
 */

import { registerWorkflowExtension } from 'pi-extensible-workflows';

// Optional provider/proxy prefix for bare model IDs. `availableModels` already
// carries `provider/model` targets, so only apply this to bare names.
const PROVIDER = process.env.PI_ROUTER_PROVIDER || '';

const withProvider = (name) =>
  !PROVIDER || name.includes('/') ? name : `${PROVIDER}/${name}`;

// Split the live inventory into capability tiers by well-known name markers.
function classify(availableModels) {
  const models = [...availableModels];

  const tier1 = models.filter((m) =>
    /(pro|agent|sonnet|opus)/i.test(m)
  );
  const tier2 = models.filter(
    (m) => /flash/i.test(m) && !/(lite|low|extra)/i.test(m)
  );
  const tier3 = models.filter((m) => /(lite|low|haiku)/i.test(m));

  const bestCode = tier1[0] || tier2[0] || models[0];
  const bestReview =
    tier1.find((m) => /(agent|opus)/i.test(m)) || bestCode;
  const bestMid = tier2[0] || bestCode;
  const bestFast = tier3[0] || tier2[0] || models[0];

  return { bestCode, bestReview, bestMid, bestFast };
}

// Build a resolver that picks a target from the live inventory. Returning a
// non-available or invalid target fails the launch before any run starts, so
// throw a clear error when nothing matches.
const pick = (select) => ({
  async resolve({ availableModels }) {
    if (availableModels.size === 0) {
      throw new Error('auto-model-router: no available models');
    }
    return withProvider(select(classify(availableModels)));
  },
});

export default function extension() {
  registerWorkflowExtension({
    version: '1.0.0',
    headline: 'Dynamic model router',
    modelAliases: {
      'developer-model': pick((t) => t.bestCode),
      'reviewer-model': pick((t) => t.bestReview),
      'scout-model': pick((t) => t.bestFast),
      'cheap-model': pick((t) => t.bestFast),
      'planner-model': pick((t) => t.bestCode),
      'security-model': pick((t) => t.bestReview),
      'designer-model': pick((t) => t.bestMid),
      fast: pick((t) => t.bestFast),
      smart: pick((t) => t.bestCode),
      deep: pick((t) => t.bestReview),
    },
  });
}
