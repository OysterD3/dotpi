/**
 * Resolving the configured advisor reference ("sonnet", "opus",
 * "openai-codex/gpt-5.6-sol") to a real registry model, and the validation
 * applied before it will be used.
 *
 * The matching rules are pi's own `--model` rules reproduced against the
 * ModelRegistry list (pi's resolver is not exported to extensions), the same
 * transcription the recap and ultracode extensions use:
 *
 *   1. canonical `provider/id`   exact, case-insensitive
 *   2. `provider/id` split       exact provider + exact id
 *   3. bare `id`                 exact, but rejected if ambiguous
 *   4. partial                   substring of id or name; prefer an alias
 *
 * Two capability checks you might expect, and what happens to them here:
 *   - "the advisor must be at least as capable as the main model". This needs a
 *     per-model capability rank. pi's registry carries no such rank for arbitrary
 *     providers, so every pair is unknown and the check reduces to allow —
 *     deliberately, not by omission.
 *   - "a model cannot advise itself". Deliberately NOT enforced. What the advisor
 *     actually buys is a clean-context read of the whole session, and that is
 *     worth having even from the same model: the reviewer sees the transcript
 *     without the anchoring of having produced it, and for a single-model setup
 *     it is that or no advisor at all. sameModel() survives only to label the
 *     case in `/advisor status`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string; readonly contextWindow?: number };

export type Resolution<M> = { ok: true; model: M } | { ok: false; error: string };

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

	const aliases = matches.filter((m) => isAlias(m.id));
	if (aliases.length === 1) return aliases[0];

	return "ambiguous";
}

/** Resolve `reference` against `models`. Exact matching first, then partial. */
export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const trimmed = reference.trim();
	if (!trimmed) return { ok: false, error: "no advisor model configured" };

	const exact = exactMatch(trimmed, models);
	if (exact === "ambiguous") {
		return { ok: false, error: `model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(trimmed, models);
	if (partial === "ambiguous") {
		return { ok: false, error: `model "${reference}" matches several models — use a more specific id` };
	}
	if (partial) return { ok: true, model: partial };

	return { ok: false, error: `model "${reference}" matched no available model` };
}

/** Canonical "provider/id" reference for a resolved model, for pi's --model flag. */
export function modelRef(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/**
 * True when both references name the same provider+id. Informational only — pi
 * allows a model to advise its own session (see the header); this just lets the
 * UI say so.
 */
export function sameModel(a: ModelLike | undefined, b: ModelLike | undefined): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
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
