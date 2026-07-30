/**
 * Drawing the usage report.
 *
 * A table, because the question `/usage` answers is comparative — which model,
 * which tool, which of them is the reason the number is what it is — and prose
 * makes that comparison by hand. Columns are padded as plain text and coloured
 * afterwards, so the alignment is computed on what is actually on screen rather
 * than on strings carrying escape sequences.
 *
 * Pure given a theme.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { BAR_CELLS, BAR_FILL, BAR_TRACK, ERROR_ABOVE_PERCENT, WARN_ABOVE_PERCENT } from "./config.ts";
import { billedTokens, cacheHitPercent, type SessionUsage, type Totals } from "./collect.ts";

export interface ReportMeta {
	sessionId?: string;
	/** Context tokens in play right now, and the window they sit in. */
	contextTokens?: number;
	contextWindow?: number;
	contextPercent?: number;
	/**
	 * Wall-clock span from the session's first entry to its last, in ms. Not
	 * time spent working — a resumed session includes everything in between.
	 */
	elapsedMs?: number;
}

export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/**
 * Four decimals up to $100, two above it.
 *
 * A column of `$0.0003` next to `$1284.0000` wastes four characters on the one
 * line where they cannot matter, and the cheap rows are exactly where a
 * fraction of a cent is still the whole number.
 */
export function formatCost(cost: number): string {
	return cost >= 100 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

export function formatElapsed(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function meterColor(percent: number | undefined): ThemeColor {
	if (percent === undefined) return "accent";
	if (percent > ERROR_ABOVE_PERCENT) return "error";
	if (percent > WARN_ABOVE_PERCENT) return "warning";
	return "success";
}

/** `[███·········]`, with any nonzero usage worth at least one cell. */
export function meter(theme: Theme, percent: number | undefined): string {
	const clamped = Math.max(0, Math.min(100, percent ?? 0));
	let filled = Math.round((clamped / 100) * BAR_CELLS);
	if (clamped > 0 && filled === 0) filled = 1;
	if (clamped < 100 && filled === BAR_CELLS) filled = BAR_CELLS - 1;
	return (
		theme.fg("muted", "[") +
		theme.fg(meterColor(percent), BAR_FILL.repeat(filled)) +
		theme.fg("muted", BAR_TRACK.repeat(BAR_CELLS - filled)) +
		theme.fg("muted", "]")
	);
}

const HEADINGS = ["Source", "calls", "input", "output", "cached", "cost"] as const;

function cells(label: string, totals: Totals): string[] {
	return [
		label,
		`${totals.calls}`,
		formatTokens(totals.input),
		formatTokens(totals.output),
		formatTokens(totals.cacheRead + totals.cacheWrite),
		formatCost(totals.cost),
	];
}

/**
 * Column widths wide enough for every row, header and total included.
 *
 * Measured on plain strings: these are all ASCII digits, model ids and tool
 * names, so `length` is the display width. Anything that could carry a wide
 * character would need visibleWidth instead.
 */
function widths(table: string[][]): number[] {
	const widest = new Array(HEADINGS.length).fill(0);
	for (const row of table) {
		for (let i = 0; i < row.length; i++) widest[i] = Math.max(widest[i]!, row[i]!.length);
	}
	return widest;
}

/** First column left, the numbers right, joined by two spaces. */
function layout(row: string[], widest: number[]): string {
	return row.map((cell, i) => (i === 0 ? cell.padEnd(widest[i]!) : cell.padStart(widest[i]!))).join("  ");
}

export function renderUsage(usage: SessionUsage, meta: ReportMeta, theme: Theme): string {
	const lines: string[] = [];

	const headline = [
		theme.fg("accent", theme.bold("● Usage")),
		meta.sessionId ? theme.fg("muted", meta.sessionId) : undefined,
		// "span", not a bare duration: this is first entry to last, so a session
		// resumed days later reads in days. Labelling it stops the number being
		// read as time spent working.
		meta.elapsedMs !== undefined ? theme.fg("muted", `${formatElapsed(meta.elapsedMs)} span`) : undefined,
		theme.fg("muted", `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`),
		usage.failed > 0 ? theme.fg("error", `${usage.failed} failed`) : undefined,
	].filter(Boolean);
	lines.push(headline.join(theme.fg("muted", "  ·  ")));

	if (meta.contextWindow) {
		const label = `${formatTokens(meta.contextTokens ?? 0)} / ${formatTokens(meta.contextWindow)}`;
		const percent = meta.contextPercent;
		lines.push(
			`${theme.fg("muted", "Context  ")}${meter(theme, percent)} ${theme.fg(meterColor(percent), label)} ${theme.fg(
				"muted",
				`(${percent === undefined ? "?" : percent.toFixed(0)}%)`,
			)}`,
		);
	}

	const body: Array<{ row: string[]; muted: boolean }> = [];
	for (const row of usage.models) body.push({ row: cells(row.label, row.totals), muted: false });
	for (const row of usage.tools) body.push({ row: cells(`${row.label} (tool)`, row.totals), muted: true });
	for (const row of usage.overhead) body.push({ row: cells(row.label, row.totals), muted: true });
	for (const row of usage.announced ?? []) body.push({ row: cells(row.label, row.totals), muted: true });

	if (body.length === 0) {
		lines.push("", theme.fg("muted", "Nothing spent yet — no model has answered in this session."));
		return lines.join("\n");
	}

	const totalRow = cells("Total", usage.total);
	const table = [[...HEADINGS], ...body.map((entry) => entry.row), totalRow];
	const widest = widths(table);
	const ruleWidth = widest.reduce((sum, width) => sum + width, 0) + 2 * (widest.length - 1);

	lines.push("");
	lines.push(theme.fg("muted", layout([...HEADINGS], widest)));
	for (const entry of body) lines.push(theme.fg(entry.muted ? "muted" : "text", layout(entry.row, widest)));
	lines.push(theme.fg("border", "─".repeat(ruleWidth)));
	lines.push(theme.bold(layout(totalRow, widest)));

	const hit = cacheHitPercent(usage.total);
	const footnotes = [
		`${formatTokens(billedTokens(usage.total))} tokens billed`,
		hit === undefined ? undefined : `${hit.toFixed(0)}% of input served from cache`,
		usage.total.reasoning > 0 ? `${formatTokens(usage.total.reasoning)} reasoning` : undefined,
	].filter(Boolean);
	lines.push(theme.fg("muted", footnotes.join("  ·  ")));

	// Said out loud rather than left to be inferred: these rows are the only ones
	// whose evidence is not in the session file, so they cover only what this pi
	// process announced and start again at zero with a new session.
	//
	// It used to promise "/workflows has the per-run breakdown". It does not —
	// no command prints per-run cost — so this points at where the figures
	// actually are rather than at a command that would show nothing.
	if (usage.announced?.length) {
		lines.push(theme.fg("muted", "Announced rows cover this session only; `/workflows show <id>` has the per-run figure."));
	}

	return lines.join("\n");
}

/**
 * A theme that paints nothing, so the same renderer serves a notify() or a
 * headless run. One report, not two that drift.
 */
const PLAIN = { fg: (_color: ThemeColor, text: string) => text, bold: (text: string) => text } as unknown as Theme;

export function plainUsage(usage: SessionUsage, meta: ReportMeta): string {
	return renderUsage(usage, meta, PLAIN);
}
