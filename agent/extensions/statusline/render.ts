/**
 * Presentation helpers: colors, number formatting, meters, and limit-window labelling.
 *
 * Everything here is pure given a theme, which keeps index.ts to wiring and layout.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BAR_FILL, BAR_TRACK, CONFIG, type ColorSpec } from "./config.ts";
import type { LimitWindow } from "./usage.ts";

/** Paint `text` with a CONFIG.colors entry, honoring either a theme role or a hex value. */
export function paint(theme: Theme, color: ColorSpec, text: string): string {
	if (!color.startsWith("#")) return theme.fg(color as ThemeColor, text);
	const r = Number.parseInt(color.slice(1, 3), 16);
	const g = Number.parseInt(color.slice(3, 5), 16);
	const b = Number.parseInt(color.slice(5, 7), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export function bar(percent: number, cells = CONFIG.barCells): { filled: string; track: string } {
	const clamped = Math.max(0, Math.min(100, percent));
	let filled = Math.round((clamped / 100) * cells);
	// Any nonzero usage gets at least one cell, else 3% of a 12-cell bar rounds to an
	// empty bar and reads as "unused". Likewise 99% keeps one track cell visible.
	if (clamped > 0 && filled === 0) filled = 1;
	if (clamped < 100 && filled === cells) filled = cells - 1;
	return { filled: BAR_FILL.repeat(filled), track: BAR_TRACK.repeat(cells - filled) };
}

/** Color for a meter, escalating as it fills. */
export function meterColor(percent: number | null): ColorSpec {
	if (percent === null) return CONFIG.colors.barFill;
	if (percent > CONFIG.errorAbovePercent) return CONFIG.colors.barError;
	if (percent > CONFIG.warnAbovePercent) return CONFIG.colors.barWarn;
	return CONFIG.colors.barFill;
}

/** `[███·····]` with the fill colored by severity and the track always dim. */
export function meter(theme: Theme, percent: number | null): string {
	const { filled, track } = bar(percent ?? 0);
	return (
		paint(theme, CONFIG.colors.barTrack, "[") +
		paint(theme, meterColor(percent), filled) +
		paint(theme, CONFIG.colors.barTrack, track) +
		paint(theme, CONFIG.colors.barTrack, "]")
	);
}

/** "resets 17:04" / "resets 17:04 Mon", or "3h 12m left" depending on CONFIG.resetStyle. */
export function formatReset(epochSeconds: number | undefined): string {
	if (epochSeconds === undefined) return "";
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "";

	if (CONFIG.resetStyle === "relative") {
		const remainingMs = reset.getTime() - Date.now();
		if (remainingMs <= 0) return "resetting";
		const minutes = Math.floor(remainingMs / 60_000);
		const hours = Math.floor(minutes / 60);
		if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
		if (hours >= 1) return `${hours}h ${minutes % 60}m left`;
		return `${minutes}m left`;
	}

	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	const sameDay = reset.toDateString() === new Date().toDateString();
	const day = reset.toLocaleDateString(undefined, { weekday: "short" });
	return sameDay ? `resets ${time}` : `resets ${time} ${day}`;
}

/**
 * Name a limit window by how long it actually is, per the API's `limit_window_seconds`.
 *
 * Not by which slot it arrived in: a ChatGPT/Codex account puts its *weekly* window in
 * `primary_window` and has no 5h window at all, so slot order says nothing about
 * duration. Falls back to a bare duration when it isn't one of the common shapes, and
 * to "Limit" when the API omits the window length entirely.
 */
export function windowLabel(window: LimitWindow): string {
	const minutes = window.windowMinutes;
	if (minutes === undefined) return "Limit";
	const hours = minutes / 60;
	if (hours <= 1) return `${Math.round(minutes)}m`;
	if (hours <= 8) return "Session";
	if (hours <= 36) return "Daily";
	if (hours <= 24 * 10) return "Weekly";
	if (hours <= 24 * 40) return "Monthly";
	return `${Math.round(hours / 24)}d`;
}

/** "Weekly: [███·····] 42% (resets 17:04)" */
export function limitSegment(theme: Theme, window: LimitWindow): string {
	const pct = Math.round(window.usedPercent);
	const reset = formatReset(window.resetsAt);
	return (
		paint(theme, CONFIG.colors.label, `${windowLabel(window)}: `) +
		meter(theme, pct) +
		` ${paint(theme, meterColor(pct), `${pct}%`)}` +
		(reset ? ` ${paint(theme, CONFIG.colors.reset, `(${reset})`)}` : "")
	);
}
