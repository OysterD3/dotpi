/**
 * The `models` contract, and what `/provider` does with it.
 *
 * ## The shape
 *
 *   "models": {
 *     "active": "openai",
 *     "providers": {
 *       "openai":    { "session": "openai-codex/gpt-5.6-sol", "cheap": "openai-codex/gpt-5.4-mini" },
 *       "anthropic": { "session": "anthropic/claude-opus-4-5", "cheap": "anthropic/claude-haiku-4-5" }
 *     }
 *   }
 *
 * Extensions then name a ROLE where they used to name a model —
 * `permissions.auto.model: "cheap"` — and switching provider is one key.
 *
 * ## Shared by string, not by module
 *
 * Six extensions here resolve model references, each with its own copy of the
 * matching rules, because every extension in this repo installs independently
 * and may not import across boundaries. This block is the same kind of contract
 * as the `usage:spend` channel: a shape both sides agree on, duplicated in a
 * fifteen-line reader (roles.ts) rather than shared as code. A producer that is
 * not installed simply never writes it, and a consumer that finds no block
 * treats every reference as a literal — which is exactly what they did before.
 */

export const SETTINGS_KEY = "models";

/**
 * The role `/provider` also pushes into the live session model.
 *
 * Reserved, because pi resolves `defaultProvider`/`defaultModel` itself long
 * before an extension runs, so those two cannot be roles. Naming one role as
 * the session's is what lets `/provider anthropic` move the main model too,
 * instead of switching everything except the thing you actually talk to.
 */
export const SESSION_ROLE = "session";

export const CONFIG = {
	/** Roles listed by `/provider` before the rest collapse into a count. */
	maxRolesShown: 12,
};
