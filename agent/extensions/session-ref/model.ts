/**
 * Resolving the summariser model, using pi's own `--model` rules reproduced
 * against the ModelRegistry list (pi's resolver is not exported to
 * extensions). The same transcription the recap, goal, permissions, advisor,
 * subagents, and dynamic-workflow extensions carry; duplicated here so this
 * extension is independently installable.
 *
 * A reference may end in `:level` — pi's `--model` syntax, which a role value
 * can carry. The FULL reference is matched first and the suffix split off
 * only when that finds nothing, because ids with colons are real (OpenRouter
 * ships `deepseek/deepseek-chat:free`). The level itself is ignored: a
 * summary earns nothing from thinking, so the suffix exists here only to be
 * stripped so the model resolves.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

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

/** One pass of the matching rules. `undefined` means it found nothing at all. */
function matchReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> | undefined {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") {
		return { ok: false, error: `summariser model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") {
		return { ok: false, error: `summariser model "${reference}" matches several models — use a more specific id` };
	}
	if (partial) return { ok: true, model: partial };

	return undefined;
}

/**
 * Resolve `reference` against `models`. Exact matching first, then partial.
 *
 * The split-on-miss retry runs only when the whole reference matched nothing:
 * an ambiguous full reference DID find models, so treating its tail as a
 * thinking level would resolve it to a model the reference never named.
 */
export function resolveModel<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const full = matchReference(reference, models);
	if (full !== undefined) return full;

	const { reference: bare, thinking } = splitThinking(reference);
	if (thinking !== undefined) {
		const stripped = matchReference(bare, models);
		if (stripped !== undefined) return stripped;
	}

	// Both misses name the reference as configured — the suffix may be the typo.
	return { ok: false, error: `summariser model "${reference}" matched no available model` };
}

/**
 * Pick the model the summary call runs on.
 *
 * An explicit reference must resolve or the summary fails: the user named it,
 * and a silent stand-in would send their transcript somewhere they did not
 * choose. With nothing configured, the `cheap` role is tried — but only when
 * a role map actually defines it; an unmapped "cheap" is a role name, not a
 * reference worth partial-matching against model ids. In every other case
 * the session model stands in: the default must not be able to break a setup
 * that configured nothing. The same policy, copied, as recap's selectModel.
 */
export function selectModel<M extends ModelLike>(
	configured: string | undefined,
	sessionModel: M | undefined,
	models: readonly M[],
	agentDir: string,
): Resolution<M> {
	if (configured) return resolveModel(resolveRole(configured, agentDir), models);

	const mapped = resolveRole(CONFIG.defaultModelRole, agentDir);
	if (mapped !== CONFIG.defaultModelRole) {
		const resolved = resolveModel(mapped, models);
		if (resolved.ok) return resolved;
	}
	return sessionModel ? { ok: true, model: sessionModel } : { ok: false, error: "no model selected" };
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
 * levels split — any other suffix is part of the id — and the registry must
 * be tried with the FULL reference before splitting, which resolveModel does.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
