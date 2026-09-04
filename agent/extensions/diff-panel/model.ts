/**
 * The change set the panel draws, and the pure parts of building it: reading
 * git's status output, describing one file from what HEAD has and what the
 * tree has, counting a diff.
 *
 * A diff is pi's own display format. `generateDiffString` is the function the
 * edit tool uses for the diff it shows in the chat, so a file here looks
 * exactly the way its last edit did — same line numbers, same context, same
 * colours once `renderDiff` paints it.
 */
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";

export type FileStatus = "modified" | "added" | "deleted";

export interface ChangedFile {
	/** Repo-relative, as git prints it. */
	path: string;
	status: FileStatus;
	added: number;
	removed: number;
	/** pi's display diff (`+12 text`), or undefined when there is nothing to draw. */
	diff?: string;
	/** Why there is no diff, when there is none. */
	note?: "binary" | "too large" | "no text change" | "unreadable";
}

export interface ChangeSet {
	files: ChangedFile[];
	added: number;
	removed: number;
}

/** One entry of `git status --porcelain=v1 -z`. */
export interface StatusEntry {
	path: string;
	/** The XY column pair, e.g. ` M`, `??`, `D `. */
	code: string;
	/** For a staged rename or copy: the path the content came from. */
	from?: string;
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * Entries are NUL-terminated `XY path`. A rename or copy — R or C in either
 * column, since a work-tree rename after `git add -N` lands in Y — is
 * followed by one more NUL-terminated field holding the original path, which
 * is kept as `from` so the file can be diffed against what it was renamed from
 * rather than shown as wholly new.
 */
export function parseStatus(out: string): StatusEntry[] {
	const fields = out.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		const path = field.slice(3);
		if (/[RC]/.test(code)) {
			const from = fields[++i];
			entries.push(from ? { path, code, from } : { path, code });
			continue;
		}
		entries.push({ path, code });
	}
	return entries;
}

/** Added and removed lines in a display diff: the ones that open with + or -. */
export function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, CONFIG.binaryProbeBytes).includes(0);
}

/**
 * Line endings normalised the way pi's edit tool normalises them (CRLF and
 * lone CR both to LF): a \r that reaches the terminal returns the cursor to
 * column 0, and the row's padding then wipes the chat to the panel's left.
 */
function text(buffer: Buffer): string {
	return buffer.toString("utf8").replace(/\r\n?/g, "\n");
}

/**
 * Describe one file from its two versions: `old` is what HEAD has (null when
 * HEAD has no such path) and `now` is what the tree has (null when the file is
 * gone). Status follows from which of the two exist, which is more reliable
 * than the XY code — and gone from the tree is a deletion whatever HEAD has,
 * so a file staged as added and then deleted again reads as deleted. The
 * reader drops that case before it gets here; there is nothing to show.
 */
export function describe(path: string, old: Buffer | null, now: Buffer | null): ChangedFile {
	const status: FileStatus = now === null ? "deleted" : old === null ? "added" : "modified";
	const file: ChangedFile = { path, status, added: 0, removed: 0 };
	if ((old?.length ?? 0) > CONFIG.maxFileBytes || (now?.length ?? 0) > CONFIG.maxFileBytes) {
		return { ...file, note: "too large" };
	}
	if ((old !== null && looksBinary(old)) || (now !== null && looksBinary(now))) {
		return { ...file, note: "binary" };
	}
	const before = old === null ? "" : text(old);
	const after = now === null ? "" : text(now);
	if (before === after) return { ...file, note: "no text change" };
	const diff = generateDiffString(before, after, CONFIG.contextLines).diff;
	return { ...file, ...countDiff(diff), diff };
}

export function changeSet(files: ChangedFile[]): ChangeSet {
	let added = 0;
	let removed = 0;
	for (const file of files) {
		added += file.added;
		removed += file.removed;
	}
	return { files, added, removed };
}

/**
 * Width of a diff line's gutter — the sign, the line number and the space
 * after it — so a wrapped line can hang its continuation under its text.
 */
export function gutterWidth(diff: string): number {
	const match = /^[+\- ]( *\d+) /m.exec(diff);
	return match ? match[1]!.length + 2 : 0;
}
