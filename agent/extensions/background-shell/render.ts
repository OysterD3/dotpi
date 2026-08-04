/**
 * Pure text building: list rows, footer lines, the exit report the model
 * reads, and the reminders. No fs, no theme — tui.ts and index.ts apply
 * colour, so everything here is testable by string comparison.
 */

import { CONFIG } from "./config.ts";
import { pidAlive, type ShellMeta, type ShellStatus } from "./store.ts";

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function statusMark(status: ShellStatus): string {
	switch (status) {
		case "running":
			return "◆";
		case "done":
			return "✓";
		case "killed":
			return "◼";
		case "interrupted":
			return "⚡";
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
	if (meta.status === "interrupted") return `was interrupted (its pi session died)`;
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

/** The one-per-turn reminder that shells are running, so the model does not forget its servers. */
export function runningReminder(running: ShellMeta[], now: number): string | undefined {
	if (running.length === 0) return undefined;
	const rows = running.map((meta) => `${meta.shellId} (\`${commandLabel(meta.command)}\`, ${formatElapsed(now - meta.startedAt)})`);
	return `Background shells running: ${rows.join(", ")}. bash_output reads new output; kill_shell stops one.`;
}

/**
 * What a fresh session is told about shells a dead session left behind.
 * Scoped to this project by the caller; names the orphan's pid when the
 * process itself outlived its owner, because that is the part worth acting on.
 */
export function interruptedNotice(interrupted: ShellMeta[]): string | undefined {
	if (interrupted.length === 0) return undefined;
	const rows = interrupted.map((meta) => {
		const orphan = pidAlive(meta.pid) ? ` — its process (pid ${meta.pid}) may STILL be running; kill it manually if unwanted` : "";
		return `${meta.shellId} (\`${commandLabel(meta.command)}\`)${orphan}`;
	});
	return [
		`A previous pi session ended without stopping ${interrupted.length === 1 ? "a background shell" : "background shells"}: ${rows.join("; ")}.`,
		`They are recorded as interrupted and are not controlled by this session.`,
	].join(" ");
}

export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
