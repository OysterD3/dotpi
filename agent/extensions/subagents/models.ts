/**
 * Resolving a subagent's model reference ("gpt-5.6-luna", "sonnet",
 * "openai-codex/gpt-5.6-sol") to a real registry model, using pi's own
 * `--model` rules reproduced against the ModelRegistry list (pi's resolver is
 * not exported to extensions). Same transcription the recap, ultracode, and
 * advisor extensions use; duplicated here so this extension is independently
 * installable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

export type Resolution<M> = { ok: true; model: M } | { ok: false; error: string };

/**
 * A Resolution that may carry the `:level` split off the reference. `thinking`
 * is set ONLY when the split path resolved — on a full match the colon was part
 * of the model id, so there is no level to carry.
 */
export type SuffixedResolution<M> = { ok: true; model: M; thinking?: string } | { ok: false; error: string };

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

export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const trimmed = reference.trim();
	if (!trimmed) return { ok: false, error: "no model given" };

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
 * resolveModelReference, for a reference that may end in `:level` — pi's own
 * `--model` syntax, which a role value can carry. The FULL reference is matched
 * first and only a clean miss splits: ids with colons are real (OpenRouter
 * ships `deepseek/deepseek-chat:free`), so splitting first would mangle them,
 * and an ambiguous full reference FOUND models as-is — its error answers the
 * question the user configured, where the bare retry could quietly resolve to
 * a model the full reference never named. Every extension that resolves
 * suffixed references keeps this rule; diverging here would make the same role
 * value resolve in one extension and error in another.
 *
 * The split's level rides back on the ok result so the caller can weigh it
 * against per-agent and default reasoning (tool.ts holds that precedence). A
 * full match carries none — its colon belonged to the id — and which model any
 * reference resolves to is unchanged from when the level was discarded.
 */
export function resolveSuffixedReference<M extends ModelLike>(reference: string, models: readonly M[]): SuffixedResolution<M> {
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
	return bare.ok ? { ok: true, model: bare.model, thinking: split.thinking } : bare;
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
 * A COPY, under the same contract-by-string discipline as resolveRole above;
 * see agent/extensions/provider/roles.ts for the original. Only pi's seven
 * levels split — any other suffix is part of the id — and the registry must be
 * tried with the FULL reference before splitting, which is what
 * resolveSuffixedReference does.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
