/**
 * Listing sessions for the picker, and loading a chosen one's active branch.
 *
 * Listing is pure given SessionInfo rows (SessionManager.list does the file
 * IO), so the exclusion, ordering, filtering, and labelling rules are all
 * testable offline. Loading follows the branch pi itself would resume: the
 * file's entries walked from its last entry, compaction-aware, via pi's own
 * buildContextEntries — a rewound session must contribute the branch the user
 * kept, not every abandoned fork.
 */

import { readFileSync } from "node:fs";
import { buildContextEntries, migrateSessionEntries, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";

/** The slice of pi's SessionInfo the picker needs. */
export type SessionRow = {
	path: string;
	id: string;
	/** Working directory the referenced session ran in — provenance, shown to the model. */
	cwd: string;
	name?: string;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
};

/**
 * Rows worth offering: not the session being sat in, none without a message,
 * only those matching the query, most recently touched first, capped so the
 * picker stays a picker. The query filters BEFORE the cap — the cap exists to
 * keep the list short, and the query is the way past it, so a search that
 * could only reach the fifteen newest rows would be no way past anything.
 */
export function pickable(rows: SessionRow[], currentSessionFile: string | undefined, query = ""): SessionRow[] {
	return rows
		.filter((row) => row.messageCount > 0)
		.filter((row) => currentSessionFile === undefined || row.path !== currentSessionFile)
		.filter((row) => matches(row, query))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, CONFIG.maxPickerRows);
}

/** Case-insensitive match over everything a person remembers a session by. */
export function matches(row: SessionRow, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return (
		(row.name?.toLowerCase().includes(needle) ?? false) ||
		row.firstMessage.toLowerCase().includes(needle) ||
		row.id.toLowerCase().includes(needle) ||
		row.allMessagesText.toLowerCase().includes(needle)
	);
}

/** What the picker shows for a row. Prefixed with an index so labels stay unique. */
export function label(row: SessionRow, index: number): string {
	const title = (row.name?.trim() || row.firstMessage.trim() || row.id.slice(0, 8)).replace(/\s+/g, " ");
	const clipped = title.length > 64 ? `${title.slice(0, 63)}…` : title;
	const date = row.modified.toISOString().slice(0, 10);
	return `${index + 1}. ${clipped}  ·  ${date}  ·  ${row.messageCount} msgs`;
}

/**
 * Load the entries the referenced session would itself resume with: its file's
 * active branch from the last entry, compaction handled by pi's own walk.
 * A missing or unparseable file loads as nothing rather than throwing — the
 * caller treats an empty branch as "nothing to reference", which is what a
 * vanished file amounts to.
 */
export function loadBranchEntries(path: string): SessionEntry[] {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const raw = parseSessionEntries(content);
	// Old session files (v1/v2) lack id/parentId until migrated; without this,
	// the branch walk terminates at the final entry and the whole conversation
	// collapses to one message. pi migrates on open; a reader must too.
	migrateSessionEntries(raw);
	const entries = raw.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (entries.length === 0) return [];
	// The leaf is stated, not defaulted: pi resumes a file at its LAST entry,
	// and this must follow the same branch.
	return buildContextEntries(entries, entries[entries.length - 1].id);
}
