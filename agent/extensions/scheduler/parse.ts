/**
 * `/schedule <text>`: one model call turns the sentence into a schedule.
 *
 * In chat the model already does this — it reads "remind me in 20 minutes" and
 * calls the `schedule` tool. The command is for when you want the schedule
 * without a turn: the sentence goes to a model with the current local time and
 * time zone (pi's system prompt carries neither), comes back as the same
 * fields the tool takes, and goes through the same validateWhen. So the two
 * entry points cannot disagree about what "tomorrow 9am" means.
 *
 * The model is `scheduler.model` from agent/settings.json when set, else the
 * session model. readParse() is pure, so every rule is testable without a call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { SETTINGS_KEY, type When } from "./config.ts";
import { selectModel } from "./model.ts";
import { validateWhen, type WhenInput } from "./state.ts";

export const PARSE_SYSTEM = [
	"You turn one request to schedule something into JSON. Answer with JSON only — no prose, no code fence.",
	"",
	'{ "prompt": "...", "in": "...", "at": "...", "every": "...", "daily": "...", "weekdays": ["..."] }',
	"",
	"- prompt: what to do when it is due, as a complete instruction to a coding agent that may be working without the user. If the request names a slash command (such as /recap), prompt is exactly that command.",
	"- Give exactly ONE of in, at, every, daily, and leave the others out:",
	'  - in: a delay from now — "20m", "1h30m", "2d".',
	'  - at: one moment in local time — "15:20", "tomorrow 09:00", "mon 09:00", or "YYYY-MM-DD HH:MM".',
	'  - every: a repeat by interval, at least 1 minute — "30m", "2h".',
	'  - daily: a repeat at a local clock time — "09:00". weekdays narrows it: ["mon","fri"], "weekdays" or "weekends".',
	'- If the request gives no time, or nothing to do, answer { "error": "what is missing" }.',
].join("\n");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The user message: now, in words and in local time, then the request. */
export function parseRequest(text: string, now: number): string {
	const date = new Date(now);
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${DAY_NAMES[date.getDay()]} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return `Now: ${stamp} (${zone})\nRequest: ${text}`;
}

/**
 * A read schedule. `fields` are the time fields as the model wrote them: the
 * confirm dialog can take minutes, so index.ts checks them again against the
 * clock at the moment you confirm ("in 20m" then means 20 minutes from then).
 */
export type ParseOutcome = { ok: true; prompt: string; when: When; fields: WhenInput } | { ok: false; error: string };

/** Strip a code fence and take the outermost JSON object, if the model added prose. */
function extractJson(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : text).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	return start !== -1 && end > start ? body.slice(start, end + 1) : undefined;
}

/** The model's answer to a schedule, checked by the same rules as a tool call. */
export function readParse(raw: string, now: number): ParseOutcome {
	const json = extractJson(raw);
	if (!json) return { ok: false, error: "the model did not answer with JSON" };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json) as Record<string, unknown>;
	} catch (error) {
		return { ok: false, error: `the model's JSON did not parse: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof parsed.error === "string" && parsed.error.trim()) return { ok: false, error: parsed.error.trim() };
	const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
	if (!prompt) return { ok: false, error: "the request says nothing to do" };
	const fields: WhenInput = { in: parsed.in, at: parsed.at, every: parsed.every, daily: parsed.daily, weekdays: parsed.weekdays };
	const when = validateWhen(fields, now);
	return when.ok ? { ok: true, prompt, when: when.value, fields } : { ok: false, error: when.error };
}

/** `scheduler.model` from agent/settings.json, or undefined. */
export function modelSetting(agentDir: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return typeof block?.model === "string" && block.model.trim() ? block.model.trim() : undefined;
	} catch {
		return undefined;
	}
}

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

export type SpendReport = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };

export interface ParseCtx {
	model?: ModelLike;
	modelRegistry: {
		getAll: () => ModelLike[];
		getApiKeyAndHeaders: (model: never) => Promise<{ ok: true; apiKey?: string; headers?: unknown; env?: unknown } | { ok: false; error: string }>;
	};
	signal?: AbortSignal;
}

/** One model call: the sentence in, a checked schedule (or the reason there is none) out. */
export async function parseSchedule(
	ctx: ParseCtx,
	text: string,
	now: number,
	configured: string | undefined,
	timeoutMs: number,
	onSpend?: (spend: SpendReport) => void,
): Promise<ParseOutcome> {
	const selected = selectModel(configured, ctx.model, ctx.modelRegistry.getAll());
	if (!selected.ok) return { ok: false, error: selected.error };
	const model = selected.model;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
	if (!auth.ok) return { ok: false, error: auth.error };
	try {
		const response = await completeSimple(
			model as never,
			{
				systemPrompt: PARSE_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: parseRequest(text, now) }], timestamp: now }],
			},
			// Reading a time out of one sentence needs no reasoning budget.
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
		// A failed call resolves rather than throws, with no text; without this
		// check an expired login read as "the model did not answer with JSON".
		if (response.stopReason === "aborted") return { ok: false, error: "the model call was cancelled" };
		if (response.stopReason === "error") return { ok: false, error: response.errorMessage || "the model call failed" };
		const answer = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return readParse(answer, now);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
