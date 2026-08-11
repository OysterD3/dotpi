/**
 * Resolving a workflow agent's model reference ("sonnet", "fable",
 * "openai-codex/gpt-5.4-mini") to an actual registry model.
 *
 * This is what makes routing said in plain language work end to end: the user
 * writes "use sonnet for implementation and fable to review" in the request,
 * the main agent passes those short references via agent()'s model option, and
 * this resolver turns them into canonical provider/id pairs before the
 * subagent is spawned — so a typo or an ambiguous reference fails that agent
 * with a clear message instead of silently running on the wrong model.
 *
 * The matching rules are pi's own `--model` rules, reproduced against the
 * ModelRegistry list (pi's resolver is not exported to extensions) — the same
 * transcription the recap extension uses:
 *
 *   1. canonical `provider/id`            exact, case-insensitive
 *   2. `provider/id` split               exact provider + exact id
 *   3. bare `id`                         exact, but rejected if ambiguous
 *   4. partial                           substring of id or name; prefer an alias
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

export type Resolution<M> =
	| { ok: true; model: M }
	| { ok: false; error: string };

/** True for an undated alias id (no trailing `-YYYYMMDD`). */
function isAlias(id: string): boolean {
	return !/-\d{8}$/.test(id);
}

function exactMatch<M extends ModelLike>(reference: string, models: readonly M[]): M | undefined | "ambiguous" {
	const trimmed = reference.trim();
	const normalized = trimmed.toLowerCase();

	const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === normalized);
	if (canonical.length === 1) return canonical[0];
	if (canonical.length > 1) return "ambiguous";

	const slash = trimmed.indexOf("/");
	if (slash !== -1) {
		const provider = trimmed.slice(0, slash).trim().toLowerCase();
		const id = trimmed.slice(slash + 1).trim().toLowerCase();
		if (provider && id) {
			const byPair = models.filter((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
			if (byPair.length === 1) return byPair[0];
			if (byPair.length > 1) return "ambiguous";
		}
	}

	const byId = models.filter((m) => m.id.toLowerCase() === normalized);
	if (byId.length === 1) return byId[0];
	if (byId.length > 1) return "ambiguous";

	return undefined;
}

function partialMatch<M extends ModelLike>(reference: string, models: readonly M[]): M | undefined | "ambiguous" {
	const needle = reference.trim().toLowerCase();
	const matches = models.filter(
		(m) => m.id.toLowerCase().includes(needle) || (m.name?.toLowerCase().includes(needle) ?? false),
	);
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];

	// Prefer aliases over dated versions, as pi does; if that narrows to one, take it.
	const aliases = matches.filter((m) => isAlias(m.id));
	if (aliases.length === 1) return aliases[0];

	return "ambiguous";
}

/**
 * Resolve `reference` against `models`. Exact matching first, then partial.
 * Pass the registry's full `getAll()` list so an explicitly named model
 * resolves even when its provider has no key yet — the spawn that follows
 * will produce the clearer auth error.
 */
/**
 * Name the models a reference could have meant.
 *
 * An unresolvable reference fails EVERY agent that uses it, so the message is
 * the only thing standing between one bad word in a script and a dead fleet.
 * "matches several models — use a more specific id" does not say which ones, so
 * the next attempt is another guess: the local run store holds five runs killed
 * outright by `model "agent"` and `model "coding"`, re-authored under new names
 * rather than corrected. Listing the candidates turns that into a single fix.
 */
function nameCandidates<M extends ModelLike>(matches: readonly M[], limit = 6): string {
	const shown = matches.slice(0, limit).map((m) => `${m.provider}/${m.id}`);
	const more = matches.length - shown.length;
	return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") {
		const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === reference.trim().toLowerCase());
		const byId = models.filter((m) => m.id.toLowerCase() === reference.trim().toLowerCase());
		const matches = canonical.length > 1 ? canonical : byId;
		return {
			ok: false,
			error: `model "${reference}" matches more than one model (${nameCandidates(matches)}) — qualify it as provider/id`,
		};
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") {
		const needle = reference.trim().toLowerCase();
		const matches = models.filter(
			(m) => m.id.toLowerCase().includes(needle) || (m.name?.toLowerCase().includes(needle) ?? false),
		);
		return {
			ok: false,
			error: `model "${reference}" matches several models (${nameCandidates(matches)}) — use one of those ids instead`,
		};
	}
	if (partial) return { ok: true, model: partial };

	// The unknown case is worth candidates too: "agent" and "coding" are not
	// model names at all, and seeing the real list is what stops the next guess.
	return { ok: false, error: `model "${reference}" matched no available model (available: ${nameCandidates(models, 8)})` };
}

/**
 * Resolve a reference that may carry a role's `:level` suffix.
 *
 * FULL first, split only on a clean miss — the order is load-bearing, because
 * ids with colons are real (OpenRouter ships `deepseek/deepseek-chat:free`)
 * and splitting first would mangle them. An ambiguous full reference FOUND
 * models as-is, so its error answers the question the user configured; the
 * bare retry could quietly resolve to a model the full reference never named.
 * Every extension that resolves suffixed references keeps this rule; diverging
 * here would make the same role value resolve in one extension and error in
 * another.
 *
 * The level itself is discarded. Thinking here is pinned per agent type and
 * per run (resolveThinking), all of it configuration written deliberately, and
 * a profile's suffix must not override it; the suffix is stripped only so the
 * model resolves.
 */
export function resolveSuffixedReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const full = resolveModelReference(reference, models);
	if (full.ok) return full;
	const trimmed = reference.trim();
	if (exactMatch(trimmed, models) === "ambiguous" || partialMatch(trimmed, models) === "ambiguous") return full;
	const split = splitThinking(reference);
	if (split.thinking === undefined) return full;
	const bare = resolveModelReference(split.reference, models);
	// A double miss reports the reference as configured — that is the string
	// in settings.json, so the one worth diagnosing. A bare ambiguity is the
	// exception: it found models, and naming them is the actionable error.
	if (!bare.ok && exactMatch(split.reference, models) !== "ambiguous" && partialMatch(split.reference, models) !== "ambiguous") return full;
	return bare;
}

/**
 * Map a model reference through the active provider profile in settings.json.
 *
 * A COPY. The `models` block is a data contract shared by string, not a module —
 * extensions here install independently and may not import across boundaries —
 * so this fifteen-line reader is duplicated into every extension that resolves a
 * model. See agent/extensions/provider/roles.ts for the original and the shape.
 *
 * Roles are checked before any matching, so a role always beats a model whose id
 * merely contains the same text. Every failure returns the reference unchanged:
 * no block, a malformed one, an unreadable file, or an undefined role all mean
 * "this was a literal model reference", which is what it meant before roles.
 */
export function resolveRole(reference: string, agentDir: string): string {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw.models as { active?: unknown; providers?: unknown } | undefined;
		if (!block || typeof block !== "object") return reference;
		const active = typeof block.active === "string" ? block.active : undefined;
		const providers = block.providers as Record<string, Record<string, unknown>> | undefined;
		if (!active || !providers || typeof providers !== "object") return reference;
		const profile = providers[active];
		if (!profile || typeof profile !== "object") return reference;
		const mapped = profile[reference];
		return typeof mapped === "string" && mapped.trim().length > 0 ? mapped.trim() : reference;
	} catch {
		return reference;
	}
}

/**
 * Split an optional trailing `:level` off a model reference.
 *
 * A COPY, for the same reason as resolveRole above — the suffix is part of the
 * role-value contract, shared by string, not by module. See
 * agent/extensions/provider/roles.ts for the original.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
