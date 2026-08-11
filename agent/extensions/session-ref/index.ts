/**
 * session-ref — `#` in the prompt: tag another session into this one.
 *
 * Type `#` while writing and the sessions of this project drop into the
 * editor's own autocomplete; pick one and a marker lands where the cursor was.
 * `#` brings the session in as a summary written by the cheap-role model,
 * `##` as its full transcript. There is no command to run first, because
 * remembering another session is something you realise mid-sentence.
 *
 * On submit the marker is replaced by the session's name in quotes and the
 * session itself arrives as a custom MESSAGE entry ahead of the prompt — it
 * enters LLM context, unlike a display entry — wrapped with provenance and one
 * guard line so a foreign transcript reads as record, not as fresh
 * instructions.
 *
 * The two modes are not symmetric, and the asymmetry is the point. A summary
 * is a bounded model call, so `#` never asks anything. A full transcript
 * re-costs on EVERY later turn of this session, so `##` prices itself against
 * the context that is actually left and asks before it is paid — declining
 * leaves the name in the sentence and injects nothing.
 *
 *   autocomplete.ts  the `#` provider, stacked on pi's own (pure rules)
 *   marker.ts        `#[Name·id]` in, quoted name out (pure)
 *   sessions.ts      picker rows and loading the chosen branch (pure rules)
 *   transcript.ts    branch -> budgeted plain text (recap's flattening, adapted)
 *   summarize.ts     the handoff-summary call
 *   model.ts         cheap-role model policy (recap's, copied)
 *   prompts.ts       summariser prompt + the injected block
 *   config.ts        budgets and thresholds
 */

import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { withRefCompletions } from "./autocomplete.ts";
import { CONFIG, MESSAGE_TYPE } from "./config.ts";
import { findMarkers, ID_CHARS, replaceMarkers, safeName, spokenName, type Marker, type RefMode } from "./marker.ts";
import { referenceBlock, type ReferenceHeader } from "./prompts.ts";
import { loadBranchEntries, pickable, type SessionRow } from "./sessions.ts";
import { summarize } from "./summarize.ts";
import { buildSections, buildTranscript, type TranscriptEntry } from "./transcript.ts";

export type RefDetails = {
	mode: RefMode;
	name: string;
	sessionId: string;
	date: string;
	/** Estimated tokens the injected block costs each turn. */
	tokens: number;
	/** Sections dropped to fit the budget (full mode). */
	dropped: number;
};

/** Session access, injectable so the flow is testable without real files. */
export type Listers = {
	list: (cwd: string) => Promise<SessionRow[]>;
	listAll: () => Promise<SessionRow[]>;
	/** The chosen session's active branch. Defaults to reading it off disk. */
	load?: (path: string) => TranscriptEntry[];
};

/**
 * pi.events channel for announcing model spend — the same string contract the
 * recap, advisor, and usage extensions share. With no subscriber it goes
 * nowhere; with the usage extension installed, the summary call's cost shows
 * up in /usage instead of being spend nothing can see.
 */
const SPEND_CHANNEL = "usage:spend";

const estimateTokens = (chars: number) => Math.ceil(chars / CONFIG.charsPerToken);

function renderRef(details: RefDetails, theme: Theme): Text {
	const lines = [
		theme.fg("accent", theme.bold(`⧉ Referenced session: ${details.name}`)),
		theme.fg("muted", `${details.mode} · ~${details.tokens.toLocaleString()} tokens · ${details.date}`),
	];
	if (details.dropped > 0) lines.push(theme.fg("dim", `${details.dropped} earlier messages did not fit`));
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Bring one referenced session in. Returns false when nothing was injected —
 * an unreadable file, an empty session, a failed summary, a declined confirm —
 * and the caller leaves that marker's text alone rather than pretending.
 */
async function injectReference(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	row: SessionRow,
	mode: RefMode,
	name: string,
	agentDir: string,
	load: (path: string) => TranscriptEntry[],
): Promise<boolean> {
	let entries: TranscriptEntry[];
	try {
		entries = load(row.path);
	} catch (error) {
		ctx.ui.notify(`Could not read "${name}": ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	if (buildSections(entries).join("").trim().length === 0) {
		ctx.ui.notify(`"${name}" has no conversation to reference.`, "info");
		return false;
	}

	const header: ReferenceHeader = {
		name,
		id: row.id,
		date: row.modified.toISOString().slice(0, 10),
		// The REFERENCED session's cwd — provenance for the model, which may be
		// reading about work done in another project entirely.
		cwd: row.cwd,
		mode,
	};

	let body: string;
	let dropped = 0;

	if (mode === "full") {
		// The price is stated against what is LEFT here, not the window on
		// paper — an injection that fills the room the next turn needed breaks
		// the session it claimed to help.
		const window = ctx.model?.contextWindow;
		const used = ctx.getContextUsage()?.tokens ?? undefined;
		const remaining = window !== undefined && used !== undefined ? Math.max(0, window - used) : undefined;
		const fullText = buildSections(entries).join("\n\n");
		const fullTokens = estimateTokens(fullText.length);
		// Zero remaining is not "unknown" — it is the worst case, and the one
		// place the severity must NOT quietly disappear.
		const share = remaining === undefined ? undefined : remaining > 0 ? fullTokens / remaining : Number.POSITIVE_INFINITY;

		// The cap is a floor-bounded share of what is LEFT: the fraction keeps
		// room for the next turn, and the floor keeps a confirmed injection
		// coherent when almost nothing is left — at the stated price of
		// forcing compaction.
		const capTokens =
			remaining !== undefined ? Math.floor(remaining * CONFIG.fullBudgetFraction) : Math.floor((window ?? 128_000) * CONFIG.fallbackWindowFraction);
		const budgetTokens = Math.max(capTokens, CONFIG.minFullBudgetTokens);
		const transcript = buildTranscript(entries, budgetTokens * CONFIG.charsPerToken);
		dropped = transcript.dropped;

		const heavy = share !== undefined && share > CONFIG.heavyShareOfRemaining;
		const fitNote = transcript.clipped
			? ` It does not fit: ${dropped > 0 ? `${dropped} earlier messages are omitted and ` : ""}even the final message is cut to the budget.`
			: dropped > 0
				? ` Only the most recent part fits: ${dropped} earlier messages are omitted.`
				: "";
		const severityNote =
			share === Number.POSITIVE_INFINITY
				? " There is NO context left — injecting this will force compaction."
				: heavy
					? " This is a LARGE share of the context you have left."
					: "";
		const confirmed = await ctx.ui.confirm(
			`Inject the full transcript of "${name}"?`,
			`~${estimateTokens(transcript.text.length).toLocaleString()} tokens of flattened conversation (messages and tool-call lines; tool results are not replayed).${fitNote} ` +
				`It becomes part of this session's context and re-costs on every future turn.${severityNote}`,
		);
		if (!confirmed) return false;
		body = transcript.text;
	} else {
		// A model call the user did not explicitly start, on the far side of
		// pressing enter: say so, or submitting looks like it hung.
		ctx.ui.notify(`Summarising "${name}"…`, "info");
		const summary = await summarize(ctx, entries, agentDir, ctx.signal, (spend) =>
			pi.events.emit(SPEND_CHANNEL, { source: "session-ref", usage: spend, calls: 1 }),
		);
		if (!summary.ok) {
			ctx.ui.notify(`Couldn't summarise "${name}": ${summary.reason}`, "warning");
			return false;
		}
		body = summary.text;
	}

	const block = referenceBlock(header, body);
	const details: RefDetails = {
		mode,
		name,
		sessionId: row.id,
		date: header.date,
		tokens: estimateTokens(block.length),
		dropped,
	};

	// The content is what the model reads; the renderer is what the user sees.
	// No turn is triggered — this runs inside the input hook, so the block is
	// appended ahead of the prompt that referenced it and the user's own
	// submit is what starts the turn.
	pi.sendMessage<RefDetails>({ customType: MESSAGE_TYPE, content: block, display: true, details }, { triggerTurn: false });
	return true;
}

export function registerSessionRef(pi: ExtensionAPI, listers: Listers): void {
	const agentDir = getAgentDir();
	const load = listers.load ?? ((path: string) => loadBranchEntries(path) as unknown as TranscriptEntry[]);
	let installed = false;

	/**
	 * Listing sessions reads and parses every session file, so it must not run
	 * per keystroke. Typing is bursty: one load covers the whole burst, and the
	 * query then filters in memory.
	 */
	const cache = new Map<string, { at: number; rows: SessionRow[] }>();
	const listCached = async (key: "here" | "all", cwd: string): Promise<SessionRow[]> => {
		const hit = cache.get(key);
		const now = Date.now();
		if (hit && now - hit.at < CONFIG.listCacheMs) return hit.rows;
		const rows = key === "here" ? await listers.list(cwd) : await listers.listAll();
		cache.set(key, { at: now, rows });
		return rows;
	};

	pi.registerMessageRenderer<RefDetails>(MESSAGE_TYPE, (message, _options, theme) =>
		message.details ? renderRef(message.details, theme) : undefined,
	);

	// Once per process, not once per session: the API stacks decorators and
	// offers no way to remove one, so registering on every session_start would
	// wrap the provider again on each /new and query the same sessions N times.
	pi.on("session_start", async (_event, ctx) => {
		cache.clear();
		if (installed || !ctx.hasUI || typeof ctx.ui.addAutocompleteProvider !== "function") return;
		installed = true;
		ctx.ui.addAutocompleteProvider((current) =>
			withRefCompletions(current, {
				rows: async (query) => {
					const currentFile = ctx.sessionManager.getSessionFile();
					// Whether to widen is decided by whether the PROJECT has
					// sessions at all, not by whether the query matched: the
					// earlier version re-read every session file on the machine
					// on every keystroke that happened to match nothing yet.
					const here = await listCached("here", ctx.cwd);
					const scoped = pickable(here, currentFile, "");
					const source = scoped.length > 0 ? here : await listCached("all", ctx.cwd);
					return pickable(source, currentFile, query);
				},
			}),
		);
	});

	/**
	 * Submit: resolve markers, inject, and hand the model a sentence.
	 *
	 * A marker that cannot be resolved is left exactly as typed and nothing is
	 * injected for it. That is the honest failure: the user sees their own
	 * text arrive unchanged rather than a reference silently going missing.
	 */
	pi.on("input", async (event, ctx) => {
		const markers = findMarkers(event.text);
		if (markers.length === 0) return { action: "continue" };
		// Both modes can open a dialog or need a notice — the summary path
		// makes a billed model call and says so first. Without a UI to say it
		// to, neither runs: a headless invocation must not quietly spend money
		// on a notice nobody receives.
		if (!ctx.hasUI) return { action: "continue" };

		const resolved = new Map<string, SessionRow>();
		for (const marker of markers) {
			if (resolved.has(marker.text)) continue;
			const row = await resolveMarker(marker, ctx, listCached);
			if (row) resolved.set(marker.text, row);
		}
		if (resolved.size === 0) return { action: "continue" };

		const done = new Set<string>();
		for (const marker of markers) {
			if (done.has(marker.text)) continue;
			const row = resolved.get(marker.text);
			if (!row) continue;
			if (await injectReference(pi, ctx, row, marker.mode, marker.name, agentDir, load)) done.add(marker.text);
		}
		if (done.size === 0) return { action: "continue" };

		return { action: "transform", text: replaceMarkers(event.text, (m) => (done.has(m.text) ? spokenName(m) : m.text)) };
	});
}

/**
 * The session a marker names.
 *
 * The id is the answer whenever the marker carries one, and it is looked for
 * across every session rather than the fifteen the picker would have shown —
 * a marker made yesterday, in another project, or recalled after a restart
 * must resolve to the same session it named when it was written.
 *
 * A hand-typed `#[name]` has no id, so it falls back to an exact name match
 * and only when exactly one session answers: two sessions with the same name
 * is not a coin to flip.
 */
async function resolveMarker(
	marker: Marker,
	ctx: ExtensionContext,
	listCached: (key: "here" | "all", cwd: string) => Promise<SessionRow[]>,
): Promise<SessionRow | undefined> {
	const currentFile = ctx.sessionManager.getSessionFile();
	const usable = (rows: SessionRow[]) => rows.filter((row) => row.path !== currentFile && row.messageCount > 0);
	const here = usable(await listCached("here", ctx.cwd));

	if (marker.id) {
		const byId = (rows: SessionRow[]) => rows.find((row) => row.id.toLowerCase().startsWith(marker.id!));
		return byId(here) ?? byId(usable(await listCached("all", ctx.cwd)));
	}

	const named = (rows: SessionRow[]) =>
		rows.filter((row) => safeName(row.name?.trim() || row.firstMessage.trim() || row.id.slice(0, ID_CHARS)) === marker.name);
	const local = named(here);
	if (local.length === 1) return local[0];
	if (local.length > 1) return undefined;
	const wide = named(usable(await listCached("all", ctx.cwd)));
	return wide.length === 1 ? wide[0] : undefined;
}

export default function (pi: ExtensionAPI) {
	const toRows = (infos: Awaited<ReturnType<typeof SessionManager.list>>): SessionRow[] =>
		infos.map((info) => ({
			path: info.path,
			id: info.id,
			cwd: info.cwd,
			name: info.name,
			modified: info.modified,
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
			allMessagesText: info.allMessagesText,
		}));

	registerSessionRef(pi, {
		list: async (cwd) => toRows(await SessionManager.list(cwd)),
		listAll: async () => toRows(await SessionManager.listAll()),
	});
}
