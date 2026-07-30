/**
 * The evaluator: a separate LLM call that decides whether the goal is met.
 *
 * The right way to constrain a judge is a provider-level JSON schema. pi's stream
 * options have no equivalent, so the schema is enforced here instead: the prompt
 * demands bare JSON, and the response is parsed leniently and then validated.
 * Anything that fails validation is an *error*, never a silent "met" — a judge
 * that cannot be understood must not be able to end the goal.
 *
 * Two details change what the judge sees rather than merely how it is called:
 *
 *   - the evaluator is a *separate* model from the session's, so judging never
 *     has to cost a frontier call. pi has no small-model concept, so `goal.model`
 *     names one; unset, the session model judges (see settings.ts).
 *   - one retry at half the transcript budget when the provider rejects the
 *     first attempt as too long, rather than failing the check outright.
 *
 * A provider rejection is NOT an exception. `completeSimple` resolves with an
 * assistant message carrying `stopReason: "error"` (or `"aborted"`) and the
 * provider's text in `errorMessage`; only transport-level failures throw. So
 * every outcome is read off the resolved value.
 *
 * The order that read happens in is load-bearing:
 *
 *   1. an abort wins over everything. A cancelled call can carry a *complete*
 *      JSON verdict followed by truncated prose, and parsing that would let
 *      Esc silently register as "Goal achieved".
 *   2. then a parsed verdict wins over overflow. `isContextOverflow`'s silent
 *      -overflow arm fires on `usage.input > contextWindow`, which a successful
 *      call can trip when the registry under-declares the window or the
 *      chars-per-token estimate under-counts (CJK, dense code). Throwing away a
 *      verdict we can read, in favour of a heuristic about how it was billed,
 *      would be strictly worse.
 *   3. only an unreadable response is diagnosed — overflow, then error.
 */

import { completeSimple, isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { resolveModel } from "./model.ts";
import { JUDGE_SYSTEM, judgeQuestion } from "./prompts.ts";
import { buildSections, fitSections, type TranscriptEntry } from "./transcript.ts";

export type Verdict =
	| { kind: "met"; reason: string }
	| { kind: "not_met"; reason: string }
	| { kind: "impossible"; reason: string }
	| { kind: "error"; reason: string }
	/** The user interrupted. Not a failure, and not worth a warning. */
	| { kind: "aborted" };

const ABORTED: Verdict = { kind: "aborted" };

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences even when told not to, so this scans for
 * the first balanced brace run rather than trusting the whole string. String
 * literals are tracked so a brace inside a quoted reason does not end the scan.
 */
export function extractJson(raw: string): unknown {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

	const start = text.indexOf("{");
	if (start === -1) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}

	return undefined;
}

/** Validate the parsed object into a Verdict. Unrecognised shapes are errors. */
export function toVerdict(parsed: unknown): Verdict {
	if (!parsed || typeof parsed !== "object") {
		return { kind: "error", reason: "evaluator did not return a JSON object" };
	}

	const record = parsed as Record<string, unknown>;
	if (typeof record.ok !== "boolean") {
		return { kind: "error", reason: "evaluator response had no boolean 'ok'" };
	}

	const reason = typeof record.reason === "string" && record.reason.trim().length > 0
		? record.reason.trim()
		: "no reason given";

	if (record.ok) return { kind: "met", reason };
	if (record.impossible === true) return { kind: "impossible", reason };
	return { kind: "not_met", reason };
}

/** Pick the model the evaluator runs on: `goal.model` if set and resolvable. */
export function selectModel(
	ctx: ExtensionContext,
	reference: string | undefined,
): { model: NonNullable<ExtensionContext["model"]> } | { error: string } {
	if (reference) {
		const resolved = resolveModel(reference, ctx.modelRegistry.getAll());
		if (resolved.ok) return { model: resolved.model };
		return { error: resolved.error };
	}
	if (ctx.model) return { model: ctx.model };
	return { error: "no model selected" };
}

/** Flattened spend from one evaluator call, for SPEND_CHANNEL. */
export type SpendReport = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };

/**
 * Run one evaluation against the current session transcript.
 *
 * `onSpend` is called once per evaluator call — including the retry after an
 * overflow, which is a second call and a second bill. A goal evaluation stores
 * only a display entry, so without this its spend is invisible to any
 * accounting; index.ts announces it.
 */
export async function evaluate(
	ctx: ExtensionContext,
	condition: string,
	signal?: AbortSignal,
	modelReference?: string,
	onSpend?: (spend: SpendReport) => void,
): Promise<Verdict> {
	const selected = selectModel(ctx, modelReference);
	if ("error" in selected) return { kind: "error", reason: selected.error };
	const model = selected.model;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { kind: "error", reason: auth.error };

	// Flattened once: a retry re-slices these sections rather than re-walking
	// the branch and re-serialising every tool call.
	const sections = buildSections(ctx.sessionManager.getBranch() as TranscriptEntry[]);

	/** One attempt. "overflow" means the transcript did not fit, so a smaller one might. */
	const ask = async (budgetFraction: number): Promise<Verdict | "overflow"> => {
		const transcript = fitSections(sections, model.contextWindow, budgetFraction);
		if (transcript.text.trim().length === 0) {
			return { kind: "not_met", reason: "insufficient evidence in transcript" };
		}

		const prompt = `<transcript>\n${transcript.text}\n</transcript>\n\n${judgeQuestion(condition)}`;

		const response = await completeSimple(
			model,
			{
				systemPrompt: JUDGE_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				timeoutMs: CONFIG.timeoutMs,
				// This is a single yes/no read, so thinking earns nothing; "minimal"
				// is the cheapest level pi exposes.
				reasoning: "minimal",
			},
		);

		// Before any verdict is returned: every branch below is an outcome of a
		// call that was already billed, including the aborted and errored ones.
		onSpend?.({
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
			cacheRead: response.usage?.cacheRead ?? 0,
			cacheWrite: response.usage?.cacheWrite ?? 0,
			reasoning: response.usage?.reasoning ?? 0,
			cost: response.usage?.cost?.total ?? 0,
		});

		// (1) An interrupted call is not evidence of anything, whatever it managed
		// to emit before it stopped.
		if (response.stopReason === "aborted" || signal?.aborted) return ABORTED;

		// (2) A response we can read is a verdict, whatever the usage numbers say.
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const parsed = extractJson(text);
		if (parsed !== undefined) return toVerdict(parsed);

		// (3) Nothing readable — now work out why.
		if (isContextOverflow(response, model.contextWindow)) return "overflow";
		if (response.stopReason === "error") {
			return { kind: "error", reason: response.errorMessage?.trim() || "evaluator call failed" };
		}
		return toVerdict(undefined);
	};

	const tooLong = { kind: "error", reason: "transcript too long for the evaluator" } as const;

	try {
		const first = await ask(CONFIG.transcriptBudgetFraction);
		if (first !== "overflow") return first;

		// fitSections always keeps the newest section, so when one message alone
		// blows the budget — a write tool call carrying a whole file, say — the
		// smaller budget yields byte-identical text. Retrying that buys a second
		// rejection and another 30s of the user's time.
		if (!fitsSmaller(sections, model.contextWindow)) return tooLong;

		const retried = await ask(CONFIG.retryBudgetFraction);
		if (retried !== "overflow") return retried;
		return tooLong;
	} catch (error) {
		// Only transport-level failures reach here: timeout, socket, timeoutMs.
		if (signal?.aborted) return ABORTED;
		return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Whether the retry budget would actually produce a smaller prompt than the first. */
function fitsSmaller(sections: string[], contextWindow: number): boolean {
	return (
		fitSections(sections, contextWindow, CONFIG.retryBudgetFraction).text.length <
		fitSections(sections, contextWindow, CONFIG.transcriptBudgetFraction).text.length
	);
}
