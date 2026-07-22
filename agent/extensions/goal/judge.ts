/**
 * The evaluator: a separate LLM call that decides whether the goal is met.
 *
 * Claude Code constrains its judge with a provider-level JSON schema. pi's stream
 * options have no equivalent, so the schema is enforced here instead: the prompt
 * demands bare JSON, and the response is parsed leniently and then validated.
 * Anything that fails validation is an *error*, never a silent "met" — a judge
 * that cannot be understood must not be able to end the goal.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { JUDGE_SYSTEM, judgeQuestion } from "./prompts.ts";
import { buildTranscript, type TranscriptEntry } from "./transcript.ts";

export type Verdict =
	| { kind: "met"; reason: string }
	| { kind: "not_met"; reason: string }
	| { kind: "impossible"; reason: string }
	| { kind: "error"; reason: string };

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

/** Run one evaluation against the current session transcript. */
export async function evaluate(
	ctx: ExtensionContext,
	condition: string,
	signal?: AbortSignal,
): Promise<Verdict> {
	const model = ctx.model;
	if (!model) return { kind: "error", reason: "no model selected" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { kind: "error", reason: auth.error };

	const entries = ctx.sessionManager.getBranch() as TranscriptEntry[];
	const transcript = buildTranscript(entries, model.contextWindow);
	if (transcript.text.trim().length === 0) {
		return { kind: "not_met", reason: "insufficient evidence in transcript" };
	}

	const prompt = `<transcript>\n${transcript.text}\n</transcript>\n\n${judgeQuestion(condition)}`;

	try {
		const response = await completeSimple(
			model,
			{ systemPrompt: JUDGE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				timeoutMs: CONFIG.timeoutMs,
				// Claude Code disables thinking for this call; "minimal" is the
				// cheapest level pi exposes.
				reasoning: "minimal",
			},
		);

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		return toVerdict(extractJson(text));
	} catch (error) {
		return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
	}
}
