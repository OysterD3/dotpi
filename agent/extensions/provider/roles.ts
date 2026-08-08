/**
 * Reading the `models` block, and turning a role into a model reference.
 *
 * Pure apart from one `readFileSync`, so the whole policy is testable.
 *
 * `resolveRole` and `splitThinking` below are the parts that get COPIED into
 * each extension that resolves models — deliberately self-contained, with no
 * imports beyond node's. Extensions here may not import across boundaries, and
 * a role map that only worked when some other extension happened to be
 * installed would be worse than none. Copy them whole; do not import this file
 * from another extension.
 *
 * Every failure returns the reference unchanged. A missing block, a malformed
 * one, an unreadable settings.json, a role nobody defined — all mean "this was
 * a literal model reference", which is what every one of these settings meant
 * before roles existed. The feature can be absent, broken, or half-configured
 * and model resolution still behaves exactly as it used to.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_ROLE, SETTINGS_KEY } from "./config.ts";

// ---------------------------------------------------------------------------
// THE COPIED PART. Keep this function self-contained.

/**
 * Map a model reference through the active provider profile.
 *
 * A role always beats a model that merely looks like it: roles are checked
 * before any matching happens, so defining a role called `fast` cannot be
 * hijacked by some provider shipping a model with `fast` in its id. That is the
 * predictable direction — you named the role, you get the role.
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
 * The suffix is pi's own `--model` syntax (`provider/id:high`), so a role can
 * carry the thinking level the model should run at. Only pi's seven levels
 * split; any other suffix stays part of the id, because ids with colons are
 * real (OpenRouter ships `deepseek/deepseek-chat:free`). Callers that match
 * against a model registry must try the FULL reference first and split only
 * when that misses — the same order as pi's parseModelPattern, and the only
 * defence for a model id that genuinely ends in a level name.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}

// ---------------------------------------------------------------------------
// The rest is only for /provider itself.

export type Profile = Record<string, string>;

export type ModelsBlock = {
	active?: string;
	providers: Record<string, Profile>;
};

export type ReadResult = { block: ModelsBlock; warnings: string[] };

/** Parse the `models` block out of a settings object, dropping what is unusable. */
export function parseBlock(raw: unknown): ReadResult {
	const warnings: string[] = [];
	const empty: ModelsBlock = { providers: {} };
	if (!raw || typeof raw !== "object") return { block: empty, warnings };

	const source = (raw as Record<string, unknown>)[SETTINGS_KEY];
	if (source === undefined) return { block: empty, warnings };
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		warnings.push(`${SETTINGS_KEY} must be an object`);
		return { block: empty, warnings };
	}

	const { active, providers } = source as { active?: unknown; providers?: unknown };
	const block: ModelsBlock = { providers: {} };

	if (active !== undefined) {
		if (typeof active === "string" && active.trim()) block.active = active.trim();
		else warnings.push(`${SETTINGS_KEY}.active must be a non-empty string`);
	}

	if (providers !== undefined) {
		if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
			warnings.push(`${SETTINGS_KEY}.providers must be an object`);
		} else {
			for (const [name, profile] of Object.entries(providers as Record<string, unknown>)) {
				if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
					warnings.push(`${SETTINGS_KEY}.providers.${name} must be an object of role -> model reference`);
					continue;
				}
				const roles: Profile = {};
				for (const [role, value] of Object.entries(profile as Record<string, unknown>)) {
					// One bad role is dropped and named; it must not cost you the
					// other nine in the same profile.
					if (typeof value === "string" && value.trim()) roles[role] = value.trim();
					else warnings.push(`${SETTINGS_KEY}.providers.${name}.${role} must be a non-empty string`);
				}
				block.providers[name] = roles;
			}
		}
	}

	return { block, warnings };
}

export function profileFor(block: ModelsBlock, name: string | undefined): Profile | undefined {
	if (!name) return undefined;
	return block.providers[name];
}

/**
 * Decide what a session reference means against the registry.
 *
 * The full reference is tried first — a model whose id genuinely ends in a
 * level name keeps it — and the split is committed only when the registry
 * confirms the bare reference. On a double miss the configured string stays an
 * unsplittable literal, the reading every consumer gives it: a genuine-colon
 * id merely absent from the registry at switch time must not be persisted
 * mangled, and a level that never resolved must not clobber the one the user
 * last set.
 */
export function splitSession(
	session: string | undefined,
	resolves: (reference: string) => boolean,
): { reference?: string; thinking?: string; resolved: boolean } {
	if (!session) return { resolved: false };
	if (resolves(session)) return { reference: session, resolved: true };
	const split = splitThinking(session);
	if (split.thinking && resolves(split.reference)) {
		return { reference: split.reference, thinking: split.thinking, resolved: true };
	}
	return { reference: session, resolved: false };
}

/**
 * What changes when the active profile becomes `next`.
 *
 * Reported before anything is written, because "switched provider" is a claim
 * worth showing your work for: a role that exists in the old profile and not in
 * the new one silently stops being a role and starts being read as a literal
 * model reference, which is the failure that would otherwise be discovered by a
 * surprising bill.
 */
export type Switch = {
	moved: Array<{ role: string; from?: string; to: string }>;
	/** Roles the current profile defines that `next` does not. */
	dropped: string[];
	/** The reference the session model becomes, when the profile names one. */
	session?: string;
};

export function planSwitch(block: ModelsBlock, next: string): Switch | { error: string } {
	const target = block.providers[next];
	if (!target) {
		const known = Object.keys(block.providers);
		return {
			error:
				known.length === 0
					? `No provider profiles are defined. Add them under "${SETTINGS_KEY}.providers" in settings.json.`
					: `Unknown provider profile "${next}". Defined: ${known.join(", ")}.`,
		};
	}

	const current = profileFor(block, block.active) ?? {};
	const moved = Object.entries(target)
		.map(([role, to]) => ({ role, from: current[role], to }))
		.sort((a, b) => a.role.localeCompare(b.role));
	const dropped = Object.keys(current)
		.filter((role) => !(role in target))
		.sort();

	return { moved, dropped, session: target[SESSION_ROLE] };
}
