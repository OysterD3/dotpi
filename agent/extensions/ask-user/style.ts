/**
 * Style resolution: which nudge wording (and which follow-up wording) a
 * session gets, based on the model that is actually generating text right
 * now.
 *
 * WHY a second style exists at all is the subject of nudge.ts's header — this
 * file is only the matching. In short: an A/B run of this extension's
 * socratic nudge showed the failure is not universal. claude-opus-5 read it
 * and asked four batched questions at minute six, exactly as designed.
 * gpt-5.6-sol, same nudge, same task, plus a user prompt that said outright
 * "if you don't understand anything, ask before you do", called ask_user
 * zero times across ten hours and burned $93 guessing wrong on the one
 * question the nudge exists to catch (a real data source vs. a demo
 * fixture). The nudge is a judgment call dressed as a suggestion — "if any
 * exist, ask" — and that is precisely the shape of instruction OpenAI-family
 * models are trained to route around in favour of finishing the task. What
 * is not optional for them is an unconditional protocol with a mandatory,
 * checkable output artifact, which is what CONTRACT_NUDGE (nudge.ts) is.
 *
 * Scoped by model rather than replacing the socratic wording outright,
 * because the asymmetry runs the other way too: claude-opus-5 did not need
 * the contract, and a model that already asks does not benefit from being
 * handed a rigid protocol instead of a judgment call — if anything a forced
 * artifact on every turn is closer to alert fatigue for a model that was
 * already complying. So this is an allowlist, not a global switch: only
 * models matched by a pattern below get the contract, everyone else keeps
 * the wording that already works for them, byte-for-byte.
 */
import type { Model } from "@earendil-works/pi-ai";

export type AskStyle = "socratic" | "contract";

/**
 * Does `pattern` — a bare provider ("openai") or a "provider/modelId" pair,
 * either half allowed one trailing `*` wildcard — match `model`?
 *
 * A bare provider (no "/") is judged against the provider alone, so it
 * matches every model under it without needing to enumerate model IDs — the
 * benchmark gap is provider-wide, not one specific release. The "/" form
 * exists for the opposite case: naming or excluding one model without
 * touching the provider-wide default.
 *
 * `pattern` is never split apart to find "the provider part" and "the model
 * part" — the "/" check above only decides which STRING to build as the
 * match target, and the whole pattern is then matched against the whole
 * target as one regex. That is what makes this safe for aggregator model IDs
 * that carry their own "/" (OpenRouter and Vercel AI Gateway both publish
 * OpenAI models as "openai/gpt-…" — see config.ts's contractModels): a
 * pattern like "openrouter/openai/gpt-*" is compared whole against
 * `${provider}/${id}` = "openrouter/openai/gpt-5.6-sol", so the id's own "/"
 * is just more literal text to match, never a delimiter this function tries
 * to parse.
 */
function matchesPattern(model: Model<any>, pattern: string): boolean {
	const target = pattern.includes("/") ? `${model.provider}/${model.id}` : model.provider;
	// Only "*" is a wildcard; every other regex metacharacter in a model ID
	// (".", "+") is escaped so it is matched literally rather than as regex.
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? ".*" : `\\${char}`));
	return new RegExp(`^${escaped}$`).test(target);
}

/**
 * Which nudge wording a model gets, right now. Pure and total: no model
 * selected yet, or a model that matches nothing in `patterns`, is
 * "socratic" — the wording that predates this file stays the default for
 * everyone not named.
 *
 * Takes `patterns` as a parameter rather than reading settings.json itself:
 * the settings file is untrusted-project-gated I/O (settings.ts), and this
 * is the pure decision its result feeds into — the split that keeps style
 * matching table-testable without touching disk, and keeps this function
 * safe to call fresh at every delivery point (index.ts) rather than once at
 * session_start, which is what lets a model_select mid-session pick up the
 * right wording on the very next nudge instead of the next session.
 */
export function askStyle(model: Model<any> | undefined, patterns: readonly string[]): AskStyle {
	if (!model) return "socratic";
	return patterns.some((pattern) => matchesPattern(model, pattern)) ? "contract" : "socratic";
}
