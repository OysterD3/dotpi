/**
 * `#` in the prompt, instead of a command before it.
 *
 * pi's editor takes ONE autocomplete provider and `ui.addAutocompleteProvider`
 * stacks a decorator on it, so this wraps whatever is already there — the
 * built-in `@file` and `/command` completion keeps working, and anything that
 * is not a `#` token is handed straight back down. The editor reads
 * `triggerCharacters` off the outermost provider only (it replaces the whole
 * set), so the inner provider's characters have to be carried up.
 *
 * The trigger pattern the editor builds is `(?:^|\s)[#][^\s]*$`: a hash at a
 * token boundary, then non-space up to the cursor. That is why a session query
 * cannot contain a space, and why `##` works without asking for anything —
 * the second hash is just part of the run.
 *
 * Everything here is pure except the two injected callbacks, so the trigger
 * rules and the splice arithmetic are testable without an editor.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { ID_CHARS, markerText, safeName, type RefMode } from "./marker.ts";
import type { SessionRow } from "./sessions.ts";

export type TriggerHit = {
	/** The text the completion replaces: hashes and query together. */
	prefix: string;
	query: string;
	mode: RefMode;
};

/**
 * The `#` token under the cursor, if that is what this is.
 *
 * `[^\s[\]]` excludes both brackets on purpose: with `[` out, a half-typed
 * `#[` never opens the list, and with `]` out the cursor sitting just after a
 * finished `#[marker]` does not reopen it either. Both are the same annoyance
 * — the popup returning over a reference you already made.
 */
export function triggerAt(line: string, cursorCol: number): TriggerHit | undefined {
	const before = line.slice(0, Math.max(0, cursorCol));
	const match = /(?:^|\s)(#{1,2})([^\s[\]]*)$/.exec(before);
	if (!match) return undefined;
	return { prefix: match[1] + match[2], query: match[2], mode: match[1] === "##" ? "full" : "summary" };
}

/** An item this provider produced, rather than one from the provider below. */
function isRefItem(item: AutocompleteItem): boolean {
	return /^#{1,2}\[/.test(item.value);
}

/**
 * What each row is called in the popup and inside the marker.
 *
 * Correctness no longer rests on this: the marker carries the session id, so
 * two rows sharing a name are still two different markers. The date is added
 * to a repeat purely so the human picking from the list can tell them apart —
 * and it is appended AFTER the length clip, because the first version ran the
 * whole thing back through safeName() and the 64-character slice ate the very
 * suffix that was meant to disambiguate.
 */
export function displayNames(rows: SessionRow[]): string[] {
	const base = rows.map((row) => safeName(row.name?.trim() || row.firstMessage.trim() || row.id.slice(0, ID_CHARS)));
	const seen = new Map<string, number>();
	for (const name of base) seen.set(name, (seen.get(name) ?? 0) + 1);
	return base.map((name, index) => ((seen.get(name) ?? 0) === 1 ? name : `${name} ${rows[index].modified.toISOString().slice(0, 10)}`));
}

export type RefCompletionDeps = {
	/** Rows to offer for a query. Already filtered, ordered and capped. */
	rows: (query: string) => Promise<SessionRow[]>;
};

export function withRefCompletions(current: AutocompleteProvider, deps: RefCompletionDeps): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "#"])],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const hit = triggerAt(lines[cursorLine] ?? "", cursorCol);
			if (!hit) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const rows = await deps.rows(hit.query);
			if (rows.length === 0) return null;

			// Nothing is remembered here. Rendering a list is not choosing from
			// it, and the earlier version wrote to a shared map on every render —
			// so a popup you never picked from could rebind a marker already
			// sitting in the prompt.
			const names = displayNames(rows);
			const items: AutocompleteItem[] = rows.map((row, index) => ({
				value: markerText(hit.mode, names[index], row.id),
				label: names[index],
				description: `${row.modified.toISOString().slice(0, 10)} · ${row.messageCount} msgs${hit.mode === "full" ? " · full transcript" : ""}`,
			}));
			return { items, prefix: hit.prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!isRefItem(item)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
			const after = line.slice(cursorCol);
			// A trailing space, like the file completion: the marker is finished
			// and the sentence carries on after it.
			const spaced = after.startsWith(" ") ? "" : " ";
			const next = [...lines];
			next[cursorLine] = `${before}${item.value}${spaced}${after}`;
			return { lines: next, cursorLine, cursorCol: before.length + item.value.length + spaced.length };
		},

		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
			? (lines, cursorLine, cursorCol) => {
					// A `#` token is ours; never let it open the file picker too.
					if (triggerAt(lines[cursorLine] ?? "", cursorCol)) return false;
					return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
				}
			: undefined,
	};
}
