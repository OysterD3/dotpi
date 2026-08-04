/**
 * Pure text building: list rows, footer lines, the exit report the model
 * reads, and the reminders. No fs, no theme — tui.ts and index.ts apply
 * colour, so everything here is testable by string comparison.
 */

import { CONFIG } from "./config.ts";
import type { ShellMeta, ShellStatus } from "./shells.ts";

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A configured threshold in prose — "5m", "90s", "1h30m" — rather than a
 * measured elapsed time. formatElapsed always keeps its trailing unit (so a
 * clock reads "5m00s", proving the seconds column is live); a THRESHOLD like
 * foregroundIdleKillMs has no such column to prove, so a bare "5m" is what a
 * person configuring it actually wrote.
 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	if (minutes < 60) return remSeconds === 0 ? `${minutes}m` : `${minutes}m${remSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes === 0 ? `${hours}h` : `${hours}h${remMinutes}m`;
}

export function statusMark(status: ShellStatus): string {
	switch (status) {
		case "running":
			return "◆";
		case "done":
			return "✓";
		case "killed":
			return "◼";
		default:
			return "✗";
	}
}

/** One line of the command, whitespace collapsed, clipped to `max` characters. */
export function commandLabel(command: string, max: number = CONFIG.commandPreview): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How a shell exit reads in prose: "exited with code 0", "was killed", … */
export function exitPhrase(meta: ShellMeta): string {
	if (meta.status === "killed") return meta.timedOut ? `timed out and was killed` : `was killed`;
	// No pid means spawn itself failed — nothing ever ran, so "died on a
	// signal" (the other way exitCode stays null) would be a lie.
	if (meta.exitCode === null) return meta.pid === undefined ? `failed to start` : `died on a signal`;
	return `exited with code ${meta.exitCode}`;
}

/** The status fragment shown beside a shell wherever it is listed. */
export function statusLabel(meta: ShellMeta, now: number): string {
	if (meta.status === "running") return `running · ${formatElapsed(now - meta.startedAt)}`;
	const elapsed = formatElapsed((meta.endedAt ?? now) - meta.startedAt);
	return `${exitPhrase(meta)} · ${elapsed}`;
}

/** A panel list row, unstyled: mark, command, status. */
export function shellRow(meta: ShellMeta, now: number): string {
	return `${statusMark(meta.status)} ${commandLabel(meta.command)}  ·  ${statusLabel(meta, now)}`;
}

/**
 * Footer lines for the statusline: one per running shell, capped, with a
 * "+N more" tail. undefined when nothing is running, so subscribers clear.
 */
export function footerLines(running: ShellMeta[], now: number): string[] | undefined {
	if (running.length === 0) return undefined;
	const shown = running.slice(0, CONFIG.footerShellLines);
	const lines = shown.map((meta) => `◆ shell ${commandLabel(meta.command, 40)} · ${formatElapsed(now - meta.startedAt)}`);
	if (running.length > shown.length) lines.push(`  +${running.length - shown.length} more shell(s)`);
	return lines;
}

/** What the bash tool returns for a background start — the model's contract. */
export function startedText(meta: ShellMeta, resultMessage: string): string {
	return [
		`Command running in background with shell id: ${meta.shellId}.`,
		`Output is being captured; call bash_output with shell_id "${meta.shellId}" to read what is new since your last check.`,
		`A "${resultMessage}" message will arrive when it exits — do not fabricate or predict its output or outcome.`,
		`The user can watch it in the footer and open the shells panel (shift+up) to inspect or kill it; kill_shell stops it from your side.`,
	].join("\n");
}

/** The exit message the model receives, tail included so short jobs need no follow-up read. */
export function exitReport(meta: ShellMeta, tail: string[], killedBy?: string): string {
	const head =
		killedBy === "panel"
			? `The user killed background shell ${meta.shellId} from the shells panel (\`${commandLabel(meta.command)}\`).`
			: `Background shell ${meta.shellId} ${exitPhrase(meta)} after ${formatElapsed((meta.endedAt ?? meta.startedAt) - meta.startedAt)}: \`${commandLabel(meta.command)}\``;
	const parts = [head];
	if (tail.length > 0) {
		parts.push(`Last output:`, ...tail);
		parts.push(`(anything earlier is available via bash_output with shell_id "${meta.shellId}")`);
	} else {
		parts.push(`(no output was produced)`);
	}
	return parts.join("\n");
}

/**
 * A settled shell's exit repeated because it may never have reached the
 * model the first time: exitReport's own wording ("exited with code 0",
 * "was killed", …) reused here via exitPhrase, not a bespoke "exited code N"
 * — the shell can just as well have been killed or have failed to spawn, and
 * pretending otherwise would misreport it.
 */
function unreachedExitRow(meta: ShellMeta, now: number): string {
	const ago = formatElapsed(now - (meta.endedAt ?? now));
	return `shell ${meta.shellId} (\`${commandLabel(meta.command)}\`) ${exitPhrase(meta)} ${ago} ago — its exit report may not have reached you.`;
}

/**
 * The one-per-turn reminder that shells are running, so the model does not
 * forget its servers — and the safety net for exits that went out as a
 * mid-turn followUp (queued behind the live turn, and wholly purged by an
 * Escape/abort before the model ever saw it). `unannounced` is every settled
 * shell index.ts has not been able to confirm reached the model any other
 * way; listing it here is itself the confirmation, since this message is
 * spliced into the next turn unconditionally rather than queued — index.ts
 * marks the shell announced only once this function has actually produced a
 * row for it.
 */
export function runningReminder(running: ShellMeta[], unannounced: ShellMeta[], now: number): string | undefined {
	const parts: string[] = [];
	if (running.length > 0) {
		const rows = running.map((meta) => `${meta.shellId} (\`${commandLabel(meta.command)}\`, ${formatElapsed(now - meta.startedAt)})`);
		parts.push(`Background shells running: ${rows.join(", ")}. bash_output reads new output; kill_shell stops one.`);
	}
	for (const meta of unannounced) parts.push(unreachedExitRow(meta, now));
	return parts.length > 0 ? parts.join("\n") : undefined;
}

export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
