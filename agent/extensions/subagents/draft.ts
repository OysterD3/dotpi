/**
 * Drafting a subagent from one sentence.
 *
 * `/subagents add a read-only reviewer` reaches here: the session model turns
 * the description into a full SubagentDef and you get one confirm instead of
 * the wizard's seven dialogs. The wizard is still there — `/subagents add`
 * with no description runs it, and a draft you do not like opens it pre-seeded
 * rather than throwing the work away.
 *
 * ## Why the draft is validated rather than trusted
 *
 * A model asked for JSON will happily invent a model id that is not signed in,
 * a thinking level that does not exist, or a tool a headless subagent cannot be
 * given. Every one of those produces a subagent that fails only when it is
 * first spawned, which may be days later. So the drafter is handed the actual
 * catalogue — the models that resolve, the seven thinking levels, the tools a
 * spawn accepts — and everything that comes back is checked against it again.
 *
 * The two halves fail differently on purpose. A name or purpose that is missing
 * is a draft that failed: there is nothing to save. An unusable model, level or
 * tool is dropped back to the inherited default and said out loud in the
 * confirm, because a subagent with no model pinned is a working subagent and
 * refusing the whole draft over one bad field would be worse.
 *
 * parseDraft() is pure, so every rule above is testable without a model call.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { NAME_PATTERN, SPAWNABLE_TOOLS, type SubagentDef, THINKING_LEVELS } from "./config.ts";
import { type ModelLike, modelRef, resolveSuffixedReference } from "./models.ts";

/** What the drafter may choose from, and what the validator checks against. */
export interface Catalog {
	/** `provider/id` for every model that actually resolves. */
	models: string[];
	tools: string[];
	levels: string[];
	takenNames: string[];
}

export function buildCatalog(models: readonly ModelLike[], takenNames: string[]): Catalog {
	return {
		models: models.map(modelRef).sort(),
		tools: [...SPAWNABLE_TOOLS],
		levels: [...THINKING_LEVELS],
		takenNames: [...takenNames].sort(),
	};
}

export const DRAFT_SYSTEM = [
	"You turn one sentence describing a coding subagent into its definition. Answer with JSON only — no prose, no code fence.",
	"",
	"{",
	'  "name": "kebab-case-name",',
	'  "purpose": "one line, what it is for — the main agent reads this to decide when to delegate",',
	'  "model": "a model id from the catalogue, or null to inherit",',
	'  "reasoning": "a thinking level from the catalogue, or null to inherit",',
	'  "tools": ["subset of the catalogue tools"] or null for all tools,',
	'  "prompt": "the role prompt: how this subagent should work, in the second person. null when the purpose says it all",',
	'  "why": "one line on the model, reasoning and tools you chose, for the human confirming this"',
	"}",
	"",
	"Rules:",
	"- Never name a model, level or tool that is not in the catalogue. Use null instead.",
	"- A read-only agent gets read-only tools. An agent that must change code needs edit and write, and bash only if it has to run something.",
	"- Reasoning: low for mechanical work, medium for ordinary implementation, high for review, design and debugging.",
	"- The name must not be one of the taken names.",
	"- Say only what the description supports. Do not invent a speciality it did not ask for.",
].join("\n");

export function draftRequest(description: string, catalog: Catalog): string {
	return [
		`Description: ${description}`,
		"",
		"Catalogue:",
		`  models: ${catalog.models.join(", ")}`,
		`  thinking levels: ${catalog.levels.join(", ")}`,
		`  tools: ${catalog.tools.join(", ")}`,
		`  names already taken: ${catalog.takenNames.length > 0 ? catalog.takenNames.join(", ") : "(none)"}`,
	].join("\n");
}

export type DraftOutcome = { ok: true; def: SubagentDef; why?: string; notes: string[] } | { ok: false; error: string };

/** Strip a code fence and take the outermost JSON object, if the model added prose. */
function extractJson(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : text).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	return start !== -1 && end > start ? body.slice(start, end + 1) : undefined;
}

/**
 * Check a draft against the catalogue. Name and purpose are required; every
 * other field degrades to the inherited default with a note rather than
 * failing the whole draft.
 */
export function parseDraft(raw: string, catalog: Catalog, models: readonly ModelLike[]): DraftOutcome {
	const json = extractJson(raw);
	if (!json) return { ok: false, error: "the drafter did not return JSON" };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json) as Record<string, unknown>;
	} catch (error) {
		return { ok: false, error: `the drafter's JSON did not parse: ${error instanceof Error ? error.message : String(error)}` };
	}

	const notes: string[] = [];
	const str = (key: string): string | undefined => {
		const value = parsed[key];
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	};

	const name = str("name");
	if (!name) return { ok: false, error: "the draft has no name" };
	if (!NAME_PATTERN.test(name)) return { ok: false, error: `"${name}" is not a kebab-case name` };
	if (catalog.takenNames.includes(name)) return { ok: false, error: `a subagent named "${name}" already exists` };

	const purpose = str("purpose");
	if (!purpose) return { ok: false, error: "the draft has no purpose" };

	let model = str("model");
	if (model) {
		// The full-name fallback accepts any id under a known provider. That is
		// right for a name a person wrote, and wrong for one a model made up: the
		// drafter was handed the catalogue, so its answer has to be in it.
		const resolved = resolveSuffixedReference(model, models);
		if (!resolved.ok || !catalog.models.includes(modelRef(resolved.model))) {
			notes.push(`dropped model "${model}" — it is not a model pi lists here`);
			model = undefined;
		}
	}

	let reasoning = str("reasoning");
	if (reasoning && !THINKING_LEVELS.has(reasoning)) {
		notes.push(`dropped reasoning "${reasoning}" — not a thinking level`);
		reasoning = undefined;
	}

	let tools: string[] | undefined;
	const rawTools = parsed.tools;
	if (Array.isArray(rawTools)) {
		const wanted = rawTools.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim().toLowerCase());
		const kept = wanted.filter((tool) => catalog.tools.includes(tool));
		const dropped = wanted.filter((tool) => !catalog.tools.includes(tool));
		if (dropped.length > 0) notes.push(`dropped unknown tool${dropped.length === 1 ? "" : "s"} ${dropped.join(", ")}`);
		if (kept.length > 0) {
			tools = [...new Set(kept)];
		} else if (wanted.length > 0) {
			// Every named tool was unknown. Leaving `tools` undefined means "all
			// tools" to spawn.ts — so a draft asked for a read-only reviewer
			// would be saved with edit, write and bash. Naming a restricted set
			// and getting the unrestricted one is the one outcome worse than
			// no draft at all, so this fails instead.
			return { ok: false, error: `none of the tools it named exist here (${wanted.join(", ")}); usable ones are ${catalog.tools.join(", ")}` };
		}
	}

	return { ok: true, def: { name, purpose, model, reasoning, tools, prompt: str("prompt") }, why: str("why"), notes };
}

export type SpendReport = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };

export interface DraftCtx {
	model?: ModelLike & { contextWindow?: number };
	modelRegistry: {
		getAll: () => ModelLike[];
		getApiKeyAndHeaders: (model: never) => Promise<{ ok: true; apiKey?: string; headers?: unknown; env?: unknown } | { ok: false; error: string }>;
	};
	signal?: AbortSignal;
}

/**
 * Draft a definition with the session model. The draft has no model setting
 * of its own, and a feature with no model configured uses the session model.
 */
export async function draftSubagent(
	ctx: DraftCtx,
	description: string,
	catalog: Catalog,
	timeoutMs: number,
	onSpend?: (spend: SpendReport) => void,
): Promise<DraftOutcome> {
	const models = ctx.modelRegistry.getAll();
	const model = ctx.model;
	if (!model) return { ok: false, error: "no model available to draft with" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
	if (!auth.ok) return { ok: false, error: auth.error };

	try {
		const response = await completeSimple(
			model as never,
			{
				systemPrompt: DRAFT_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: draftRequest(description, catalog) }], timestamp: Date.now() }],
			},
			{ apiKey: auth.apiKey, headers: auth.headers as never, env: auth.env as never, signal: ctx.signal, timeoutMs, reasoning: "minimal" },
		);
		onSpend?.({
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
			cacheRead: response.usage?.cacheRead ?? 0,
			cacheWrite: response.usage?.cacheWrite ?? 0,
			reasoning: response.usage?.reasoning ?? 0,
			cost: response.usage?.cost?.total ?? 0,
		});
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const outcome = parseDraft(text, catalog, models);
		// Resolving against the registry says the id EXISTS (or, for a full
		// name the registry does not list, that its provider does), not that
		// you can call it. The catalogue cannot know that — auth is a separate
		// async lookup — so the one model that was actually chosen is checked
		// here. Without this the subagent saves cleanly and dies on its first
		// spawn, which is exactly the delayed failure this file exists to
		// prevent.
		if (outcome.ok && outcome.def.model) {
			const pick = resolveSuffixedReference(outcome.def.model, models);
			if (pick.ok) {
				const usable = await ctx.modelRegistry.getApiKeyAndHeaders(pick.model as never);
				if (!usable.ok) {
					outcome.notes.push(`dropped model "${outcome.def.model}" — it resolves but is not signed in here (${usable.error})`);
					outcome.def.model = undefined;
				}
			}
		}
		return outcome;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
