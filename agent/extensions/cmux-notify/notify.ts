/**
 * Building the cmux notification: deciding whether to send one, and what it
 * says. Pure — index.ts owns the subprocess.
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

/** Running inside a cmux surface, and not silenced. */
export function shouldSend(env: NodeJS.ProcessEnv): boolean {
	if (env.CMUX_PI_HOOKS_DISABLED === "1") return false;
	return Boolean(env.CMUX_SURFACE_ID);
}
