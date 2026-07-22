/**
 * Rendering diagnostics compactly. Pure functions only.
 *
 * Format is `path:line:col: severity: message [source code]` — the same shape compilers
 * and editors use, so it is immediately legible and cheap in tokens.
 */

import { relative } from "node:path";
import type { Diagnostic } from "./client.ts";
import { CONFIG } from "./config.ts";
import type { FileDiagnostics } from "./manager.ts";

const SEVERITY = ["", "error", "warning", "info", "hint"] as const;

export function severityName(severity: number | undefined): string {
	return SEVERITY[severity ?? 1] ?? "error";
}

/** LSP positions are 0-based; humans and compilers count from 1. */
export function formatDiagnostic(diagnostic: Diagnostic, path: string): string {
	const line = diagnostic.range.start.line + 1;
	const column = diagnostic.range.start.character + 1;
	const origin = [diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
	const suffix = origin ? ` [${origin}]` : "";
	const message = diagnostic.message.replace(/\s+/g, " ").trim();
	return `${path}:${line}:${column}: ${severityName(diagnostic.severity)}: ${message}${suffix}`;
}

/** Errors first, then by position, so the most actionable line is at the top. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	return [...diagnostics].sort((a, b) => {
		const bySeverity = (a.severity ?? 1) - (b.severity ?? 1);
		if (bySeverity !== 0) return bySeverity;
		const byLine = a.range.start.line - b.range.start.line;
		if (byLine !== 0) return byLine;
		return a.range.start.character - b.range.start.character;
	});
}

export type Counts = { errors: number; warnings: number; other: number };

export function countDiagnostics(files: FileDiagnostics[]): Counts {
	const counts: Counts = { errors: 0, warnings: 0, other: 0 };
	for (const file of files) {
		for (const diagnostic of file.diagnostics) {
			if ((diagnostic.severity ?? 1) === 1) counts.errors++;
			else if (diagnostic.severity === 2) counts.warnings++;
			else counts.other++;
		}
	}
	return counts;
}

export function summarize(files: FileDiagnostics[]): string {
	const { errors, warnings, other } = countDiagnostics(files);
	const failed = files.filter((file) => file.error).length;
	const parts = [`${errors} error(s)`, `${warnings} warning(s)`];
	if (other > 0) parts.push(`${other} hint(s)`);
	if (failed > 0) parts.push(`${failed} file(s) unavailable`);
	return `${parts.join(", ")} across ${files.length} file(s)`;
}

/** Full tool output. `cwd` shortens paths to something readable. */
export function formatResults(files: FileDiagnostics[], cwd: string): string {
	const blocks: string[] = [];

	for (const file of files) {
		const shortPath = shorten(file.path, cwd);

		if (file.error) {
			blocks.push(`${shortPath}: ${file.error}`);
			continue;
		}

		if (file.diagnostics.length === 0) {
			blocks.push(`${shortPath}: no diagnostics${file.server ? ` (${file.server})` : ""}`);
			continue;
		}

		const sorted = sortDiagnostics(file.diagnostics);
		const shown = sorted.slice(0, CONFIG.maxDiagnosticsPerFile);
		const lines = shown.map((diagnostic) => formatDiagnostic(diagnostic, shortPath));
		if (sorted.length > shown.length) {
			// Never truncate silently.
			lines.push(`… ${sorted.length - shown.length} more diagnostic(s) in this file`);
		}
		blocks.push(lines.join("\n"));
	}

	return `${summarize(files)}\n\n${blocks.join("\n\n")}`;
}

function shorten(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}
