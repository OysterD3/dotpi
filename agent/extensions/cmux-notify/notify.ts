/**
 * Building the cmux notification: deciding whether to send one, and what it
 * says. Pure — index.ts owns the subprocess.
 *
 * Two things block on a human: a permission prompt and an ask_user question.
 * They arrive on different channels with different payloads and read differently
 * in the banner, but land on the same cmux event — `permission_prompt` is what
 * flips the session to needsInput, whatever it is actually waiting for.
 */
import { CONFIG } from "./config.ts";

/** What the permissions extension announces when it is about to block. */
export interface AskEvent {
	tool: string;
	/** The command for bash, the path for read/write/edit, "" otherwise. */
	target: string;
	/** One line explaining why approval is needed. */
	reason: string;
	/** Stable pattern ids, e.g. ["git-force-push"]. */
	findings: string[];
	sessionId?: string;
	cwd?: string;
}

/** Narrow a bus payload, which arrives as `unknown`. */
export function asAskEvent(data: unknown): AskEvent | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.tool !== "string" || !record.tool) return undefined;
	return {
		tool: record.tool,
		target: typeof record.target === "string" ? record.target : "",
		reason: typeof record.reason === "string" ? record.reason : "",
		findings: Array.isArray(record.findings) ? record.findings.filter((f): f is string => typeof f === "string") : [],
		sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
		cwd: typeof record.cwd === "string" ? record.cwd : undefined,
	};
}

/** Collapse to one line and cap, so a heredoc or long path stays readable. */
export function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * The banner text. cmux titles it "Pi | Permission | <message>", so the message
 * carries the what — the tool and what it wants to touch.
 */
export function buildMessage(event: AskEvent): string {
	const verb = event.tool === "bash" ? "run" : `use ${event.tool} on`;
	const target = oneLine(event.target, CONFIG.targetChars);
	if (!target) return `Pi needs your permission to use ${event.tool}`;
	return `Pi needs your permission to ${verb}: ${target}`;
}

/** The JSON cmux reads on stdin. */
export function buildPayload(event: AskEvent, sessionId: string, cwd: string): Record<string, unknown> {
	return {
		session_id: sessionId,
		cwd,
		hook_event_name: CONFIG.hookEventName,
		event: CONFIG.hookEventName,
		notification_type: CONFIG.notificationType,
		message: buildMessage(event),
		title: "Pi needs approval",
		tool_name: event.tool,
		reason: event.reason || undefined,
		findings: event.findings.length > 0 ? event.findings : undefined,
	};
}

// ------------------------------------------------------------------ questions

/** What the ask-user extension announces when it puts a question to the user. */
export interface QuestionEvent {
	/** True when the question opens, false once it is answered or dismissed. */
	active: boolean;
	/** The first question's text — what the banner says. */
	question: string;
	/** The model's short label for it, e.g. "Auth method". */
	header?: string;
	/** How many questions the one call carried. */
	count: number;
	sessionId?: string;
	cwd?: string;
}

/**
 * Narrow a bus payload. The closing announcement carries only `active: false`,
 * so a missing question is normal rather than malformed — index.ts drops those
 * by checking `active`, which keeps this function faithful to what was sent.
 */
export function asQuestionEvent(data: unknown): QuestionEvent | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.active !== "boolean") return undefined;
	const count = typeof record.count === "number" && record.count > 0 ? Math.floor(record.count) : 1;
	return {
		active: record.active,
		question: typeof record.question === "string" ? record.question.trim() : "",
		header: typeof record.header === "string" && record.header.trim() ? record.header.trim() : undefined,
		count,
		sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
		cwd: typeof record.cwd === "string" ? record.cwd : undefined,
	};
}

/**
 * The banner text. The question itself is the whole point of the interruption,
 * so it is what the line carries; a multi-question call says so, because "answer
 * one thing" and "answer four things" are different amounts of attention.
 */
export function buildQuestionMessage(event: QuestionEvent): string {
	const question = oneLine(event.question, CONFIG.targetChars);
	const lead = event.count > 1 ? `Pi is asking ${event.count} questions` : "Pi is asking";
	return question ? `${lead}: ${question}` : `${lead} for your input`;
}

/** The JSON cmux reads on stdin for a question. */
export function buildQuestionPayload(event: QuestionEvent, sessionId: string, cwd: string): Record<string, unknown> {
	return {
		session_id: sessionId,
		cwd,
		hook_event_name: CONFIG.hookEventName,
		event: CONFIG.hookEventName,
		// Load-bearing for needsInput, and just as true of a question as of an
		// approval: pi is stopped until the human acts.
		notification_type: CONFIG.notificationType,
		message: buildQuestionMessage(event),
		title: "Pi has a question",
		tool_name: CONFIG.questionTool,
		reason: event.header,
	};
}

/** Running inside a cmux surface, and not silenced. */
export function shouldSend(env: NodeJS.ProcessEnv): boolean {
	if (env.CMUX_PI_HOOKS_DISABLED === "1") return false;
	return Boolean(env.CMUX_SURFACE_ID);
}
