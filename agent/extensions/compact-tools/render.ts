/**
 * The compact summaries — pure string builders, one per built-in tool, for the
 * call line and the result line. Each takes an injected `theme` (so tests pass
 * identity colour functions) and returns a string; index.ts wraps it in a Text
 * component. When `expanded`, the result functions append up to `expandedLines`
 * lines of detail, matching pi's ctrl+o behaviour without the built-in's
 * 10-line-when-collapsed default.
 */

import { CONFIG } from "./config.ts";

/** The slice of pi's theme these use; identity-able in tests. */
export interface Theme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

type Content = { type?: string; text?: string };
type Result = { content?: Content[]; details?: unknown };

/** Join the text blocks of a tool result. */
export function textOf(result: Result): string {
	return (result.content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function nonEmptyLineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function elide(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Append up to `expandedLines` detail lines, dimmed, with a "… N more" footer. */
function withDetail(head: string, body: string, expanded: boolean, theme: Theme, expandedLines: number, colour = "dim"): string {
	if (!expanded || !body) return head;
	const lines = body.split("\n");
	const shown = lines.slice(0, expandedLines);
	let out = head;
	for (const line of shown) out += `\n${theme.fg(colour, line)}`;
	if (lines.length > expandedLines) out += `\n${theme.fg("muted", `… ${lines.length - expandedLines} more lines`)}`;
	return out;
}

function errorLine(result: Result, theme: Theme): string | undefined {
	const text = textOf(result);
	if (text.startsWith("Error")) return theme.fg("error", text.split("\n")[0]);
	return undefined;
}

// --------------------------------------------------------------------- calls

export function callLine(name: string, args: Record<string, unknown>, theme: Theme): string {
	const title = (label: string) => theme.fg("toolTitle", theme.bold(label));
	const path = (p: unknown) => theme.fg("accent", String(p ?? ""));
	switch (name) {
		case "read": {
			let text = `${title("read ")}${path(args.path)}`;
			const parts: string[] = [];
			if (args.offset) parts.push(`offset=${args.offset}`);
			if (args.limit) parts.push(`limit=${args.limit}`);
			if (parts.length) text += theme.fg("dim", ` (${parts.join(", ")})`);
			return text;
		}
		case "bash":
			return `${title("$ ")}${theme.fg("accent", elide(String(args.command ?? ""), CONFIG.callMaxChars))}`;
		case "edit":
			return `${title("edit ")}${path(args.path)}`;
		case "write":
			return `${title("write ")}${path(args.path)}${theme.fg("dim", ` (${String(args.content ?? "").split("\n").length} lines)`)}`;
		case "grep": {
			let text = `${title("grep ")}${theme.fg("accent", elide(String(args.pattern ?? ""), CONFIG.callMaxChars))}`;
			if (args.path) text += theme.fg("dim", ` in ${args.path}`);
			return text;
		}
		case "find": {
			const q = args.pattern ?? args.name ?? args.query ?? "";
			let text = `${title("find ")}${theme.fg("accent", elide(String(q), CONFIG.callMaxChars))}`;
			if (args.path) text += theme.fg("dim", ` in ${args.path}`);
			return text;
		}
		case "ls":
			return `${title("ls ")}${path(args.path ?? ".")}`;
		default:
			return title(name);
	}
}

// -------------------------------------------------------------------- results

export function resultLine(name: string, result: Result, expanded: boolean, theme: Theme, expandedLines: number): string {
	const err = errorLine(result, theme);
	if (err) return err;
	const text = textOf(result);

	switch (name) {
		case "read": {
			const first = result.content?.[0];
			if (first?.type === "image") return theme.fg("success", "image");
			const lineCount = text ? text.split("\n").length : 0;
			let head = theme.fg("success", `${lineCount} lines`);
			const trunc = (result.details as { truncation?: { truncated?: boolean; totalLines?: number } })?.truncation;
			if (trunc?.truncated) head += theme.fg("warning", ` (of ${trunc.totalLines})`);
			return withDetail(head, text, expanded, theme, expandedLines);
		}
		case "bash": {
			const exitMatch = text.match(/exit code:\s*(\d+)/i);
			const exit = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
			const lines = nonEmptyLineCount(text);
			let head = exit && exit !== 0 ? theme.fg("error", `exit ${exit}`) : theme.fg("success", "done");
			head += theme.fg("dim", ` (${lines} line${lines === 1 ? "" : "s"})`);
			return withDetail(head, text, expanded, theme, expandedLines);
		}
		case "edit": {
			const diff = (result.details as { diff?: string })?.diff;
			if (!diff) return theme.fg("success", "applied");
			const diffLines = diff.split("\n");
			let adds = 0;
			let dels = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) adds++;
				if (line.startsWith("-") && !line.startsWith("---")) dels++;
			}
			const head = `${theme.fg("success", `+${adds}`)}${theme.fg("dim", " / ")}${theme.fg("error", `-${dels}`)}`;
			return withDetail(head, diff, expanded, theme, expandedLines, "dim");
		}
		case "write":
			return theme.fg("success", "written");
		case "grep":
		case "find":
		case "ls": {
			const count = nonEmptyLineCount(text);
			const label =
				name === "grep"
					? count === 1
						? "match"
						: "matches"
					: name === "find"
						? count === 1
							? "result"
							: "results"
						: count === 1
							? "entry"
							: "entries";
			const head = theme.fg("success", `${count} ${label}`);
			return withDetail(head, text, expanded, theme, expandedLines);
		}
		default:
			return theme.fg("success", "done");
	}
}
