/**
 * Model-id normalization, shared by pricing lookup, context-window resolution and
 * billing calibration. Kept in its own module so the calibration accumulator can key
 * models the same way without importing the cost estimator (which imports it back).
 */
export function normalizeModelName(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    // Drop a release-date snapshot suffix: claude-haiku-4-5-20251001 -> claude-haiku-4-5
    .replace(/-\d{8}$/, '')
    // Provider APIs dash-separate the minor version while the pricing keys use a
    // dot, so the raw API id never matched: claude-opus-4-8 -> claude-opus-4.8,
    // claude-3-5-sonnet -> claude-3.5-sonnet.
    .replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2');
}

/**
 * Who serves a model, read from the vendor prefix VS Code puts on a chat model id
 * (`<vendor>/<model>`).
 *
 * - `provider` - no prefix, or `copilot/` / `github-copilot/`. Billed by the session's
 *   own provider (GitHub for Copilot, Anthropic for Claude Code, ...).
 * - `local`   - a vendor that runs on the user's own machine (Ollama, LM Studio, a
 *   llama.cpp server behind the OpenAI-compatible endpoint, ...). Nobody bills it.
 * - `byok`    - any other vendor: the user's own key for a hosted API, or a third-party
 *   model extension. Not billed by the session's provider; priced at the vendor's list rate when known.
 *
 * `customoai` (VS Code's "OpenAI Compatible" endpoint) counts as local: it is how a
 * llama.cpp / vLLM / LocalAI server is attached, and the session log does not record
 * the endpoint URL, so a hosted endpoint configured that way is indistinguishable.
 */
export type ModelHosting = 'provider' | 'local' | 'byok';

const COPILOT_MODEL_VENDORS = new Set(['copilot', 'github-copilot']);
const LOCAL_MODEL_VENDORS = new Set([
  'ollama', 'lmstudio', 'lm-studio', 'llamacpp', 'llama.cpp', 'llama-cpp',
  'customoai', 'vllm', 'localai', 'foundrylocal', 'foundry-local', 'jan', 'local',
]);

/** The vendor prefix of a `<vendor>/<model>` id, lowercased, or null when there is none. */
export function modelVendor(model: string): string | null {
  const slash = model.indexOf('/');
  if (slash <= 0) { return null; }
  return model.slice(0, slash).trim().toLowerCase();
}

/** The model id without its vendor prefix. */
export function stripModelVendor(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

export function modelHosting(model: string): ModelHosting {
  const vendor = modelVendor(model);
  if (vendor === null || COPILOT_MODEL_VENDORS.has(vendor)) { return 'provider'; }
  return LOCAL_MODEL_VENDORS.has(vendor) ? 'local' : 'byok';
}

export function isLocalModel(model: string): boolean {
  return modelHosting(model) === 'local';
}
