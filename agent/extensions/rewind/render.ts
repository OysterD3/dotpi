/**
 * Formatting for the picker and the result summary. Pure.
 */

import { CONFIG } from "./config.ts";
import type { RewindPoint } from "./history.ts";
import type { RestoreOutcome } from "./restore.ts";

/** Collapse a prompt to one short line for the picker. */
export function previewPrompt(prompt: string): string {
	const line = prompt.replace(/\s+/g, " ").trim();
	if (line.length === 0) return "(empty prompt)";
	return line.length > CONFIG.promptPreviewChars
		? `${line.slice(0, CONFIG.promptPreviewChars - 1)}…`
		: line;
}

/** Relative age, e.g. "just now", "4m ago", "2h ago". */
export function relativeTime(from: number, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - from) / 1000));
	if (seconds < 45) return "just now";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * One picker row. The file count is the whole point of the row: it tells the
 * user whether "restore code" would actually do anything at this point.
 */
export function pickerLabel(point: RewindPoint, index: number, now?: number): string {
	const count = point.changed.length;
	const files = count === 0 ? "no file changes" : `${count} file${count === 1 ? "" : "s"}`;
	return `${String(index + 1).padStart(2)}. ${previewPrompt(point.checkpoint.prompt)}  ·  ${files}  ·  ${relativeTime(point.checkpoint.at, now)}`;
}

/** Human summary of what a restore did. Claude Code's wording for the headline. */
export function summarize(outcome: RestoreOutcome, cwd: string): string {
	const short = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
	const lines: string[] = [];

	const touched = outcome.restored.length + outcome.deleted.length;
	lines.push(
		touched === 0
			? "Files already matched that point; nothing changed."
			: `Files rewound to state at message (${touched} changed).`,
	);

	for (const path of outcome.restored) lines.push(`  restored  ${short(path)}`);
	for (const path of outcome.deleted) lines.push(`  deleted   ${short(path)}`);
	for (const item of outcome.refused) lines.push(`  skipped   ${short(item.path)} — ${item.reason}`);

	return lines.join("\n");
}
