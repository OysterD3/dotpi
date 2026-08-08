/**
 * Resolving the configured classifier model reference to an actual model.
 *
 * pi's own resolver (`findExactModelReferenceMatch` / `resolveCliModel`) is not
 * exported to extensions and needs the `ModelRuntime`, which extensions do not
 * get — they get the `ModelRegistry` facade and its `getAll()`. So the matching
 * rules are reproduced here against that list, deliberately the same rules pi
 * applies, so `permissions.auto.model` behaves like `--model` does:
 *
 *   1. canonical `provider/id`            exact, case-insensitive
 *   2. `provider/id` split                exact provider + exact id
 *   3. bare `id`                          exact, but rejected if ambiguous
 *   4. partial                            substring of id or name; prefer an alias
 *
 * A reference that matches nothing and ends in one of pi's thinking levels —
 * `provider/id:high`, the `--model` suffix a role value may carry — runs the
 * same four steps again without the suffix. The level itself goes nowhere: the
 * classifier's thinking is pinned in config.ts, not carried on the reference.
 *
 * Ambiguity is an error rather than a silent pick, and here that matters more
 * than it does elsewhere: an unresolvable reference degrades auto mode to the
 * deterministic table, and being told which model was meant is the difference
 * between noticing that and not.
 *
 * Deliberately duplicated from the goal and recap extensions rather than shared —
 * every extension in this repo is independently installable, so a file may not
 * import across extension boundaries.
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

function matchOnce<M extends ModelLike>(
	reference: string,
	models: readonly M[],
): M | undefined | "ambiguous-exact" | "ambiguous-partial" {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") return "ambiguous-exact";
	if (exact) return exact;
	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") return "ambiguous-partial";
	return partial;
}

/**
 * Resolve `reference` against `models`. Exact matching first, then partial.
 * `models` should be the registry's list; pass `getAll()` so an explicitly named
 * model resolves even when its provider has no key yet — the auth check that
 * follows will produce the clearer error.
 */
export function resolveModel<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	// Full reference first, split only on a miss. Ids with colons are real —
	// OpenRouter ships `deepseek/deepseek-chat:free` — so a registry carrying
	// both `m` and `m:high` must answer `m:high` for the full string, and an
	// ambiguous match is not a miss: the reference found models as-is, and
	// splitting it would answer a different question. Same order as pi's own
	// parseModelPattern.
	let match = matchOnce(reference, models);
	if (match === undefined) {
		const split = splitThinking(reference);
		// The level is stripped, never plumbed: the classifier's thinking is
		// pinned in config.ts (`AUTO.reasoning`), a deliberate choice the role
		// map does not get to override. The split exists so the model resolves.
		if (split.thinking !== undefined) match = matchOnce(split.reference, models);
	}

	if (match === "ambiguous-exact") {
		return { ok: false, error: `permissions.auto.model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (match === "ambiguous-partial") {
		return { ok: false, error: `permissions.auto.model "${reference}" matches several models — use a more specific id` };
	}
	if (match) return { ok: true, model: match };

	return { ok: false, error: `permissions.auto.model "${reference}" matched no available model` };
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
 * A COPY, like resolveRole above — see agent/extensions/provider/roles.ts for
 * the original. The suffix is pi's `--model` syntax (`provider/id:high`), so a
 * role value can carry a thinking level; only pi's seven levels split, because
 * ids with colons are real (OpenRouter ships `deepseek/deepseek-chat:free`).
 * resolveModel tries the full reference first and splits only on a miss, and
 * discards the level it finds — this extension's thinking is pinned in
 * config.ts, so the split exists purely so the model resolves.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
