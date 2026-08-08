/**
 * session-ref — `/ref`: tag another session into this one.
 *
 * Picks a session (this project's first, all projects on request or when the
 * project has none), then asks HOW to bring it in:
 *
 *   summary  a structured handoff written by the cheap-role model
 *   full     the flattened transcript, budgeted against the context that is
 *            actually LEFT here, and always behind a confirm — the injection
 *            re-costs on every later turn of this session, so its price is
 *            stated before it is paid
 *
 * Either way the result is a custom MESSAGE entry (it enters LLM context,
 * unlike a display entry), wrapped with provenance and one guard line so the
 * foreign transcript reads as record, not as fresh instructions. Every dialog
 * step can be escaped; nothing is injected until the last one.
 *
 *   sessions.ts    picker rows and loading the chosen branch (pure rules)
 *   transcript.ts  branch -> budgeted plain text (recap's flattening, adapted)
 *   summarize.ts   the handoff-summary call
 *   model.ts       cheap-role model policy (recap's, copied)
 *   prompts.ts     summariser prompt + the injected block
 *   config.ts      budgets and thresholds
 */

import { getAgentDir, SessionManager, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG, MESSAGE_TYPE } from "./config.ts";
import { referenceBlock, type ReferenceHeader } from "./prompts.ts";
import { label, loadBranchEntries, pickable, type SessionRow } from "./sessions.ts";
import { summarize } from "./summarize.ts";
import { buildSections, buildTranscript, type TranscriptEntry } from "./transcript.ts";

export type RefDetails = {
	mode: "summary" | "full";
	name: string;
	sessionId: string;
	date: string;
	/** Estimated tokens the injected block costs each turn. */
	tokens: number;
	/** Sections dropped to fit the budget (full mode). */
	dropped: number;
};

/** Session listers, injectable so the command is testable without real files. */
export type Listers = {
	list: (cwd: string) => Promise<SessionRow[]>;
	listAll: () => Promise<SessionRow[]>;
};

const ALL_PROJECTS = "⌕ search all projects…";

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

export function registerRefCommand(pi: ExtensionAPI, listers: Listers): void {
	const agentDir = getAgentDir();

	pi.registerMessageRenderer<RefDetails>(MESSAGE_TYPE, (message, _options, theme) =>
		message.details ? renderRef(message.details, theme) : undefined,
	);

	pi.registerCommand("ref", {
		description: "Reference another session here, as a summary or its full transcript (/ref [query])",

		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const query = args.trim();
			const currentFile = ctx.sessionManager.getSessionFile();

			// This project's sessions first; all projects when asked, or when the
			// project has nothing else to offer. The query filters before the
			// picker cap (inside pickable), so a search reaches sessions the
			// capped list would never show.
			let rows = pickable(await listers.list(ctx.cwd), currentFile, query);
			let scoped = true;
			if (rows.length === 0) {
				rows = pickable(await listers.listAll(), currentFile, query);
				scoped = false;
			}
			if (rows.length === 0) {
				ctx.ui.notify(query ? `No session matches "${query}".` : "No other sessions to reference.", "info");
				return;
			}

			const options = rows.map((row, index) => label(row, index));
			if (scoped) options.push(ALL_PROJECTS);
			const picked = await ctx.ui.select("Reference which session?", options);
			if (picked === undefined) return;

			let row: SessionRow;
			if (picked === ALL_PROJECTS) {
				const everywhere = pickable(await listers.listAll(), currentFile, query);
				if (everywhere.length === 0) {
					ctx.ui.notify("No sessions in other projects either.", "info");
					return;
				}
				const wide = await ctx.ui.select("Reference which session?", everywhere.map((r, index) => label(r, index)));
				if (wide === undefined) return;
				row = everywhere[everywhere.map((r, index) => label(r, index)).indexOf(wide)];
			} else {
				row = rows[options.indexOf(picked)];
			}

			let entries: TranscriptEntry[];
			try {
				entries = loadBranchEntries(row.path) as unknown as TranscriptEntry[];
			} catch (error) {
				ctx.ui.notify(`Could not read that session: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const fullText = buildSections(entries).join("\n\n");
			if (fullText.trim().length === 0) {
				ctx.ui.notify("That session has no conversation to reference.", "info");
				return;
			}

			// The price is stated against what is LEFT here, not the window on
			// paper — an injection that fills the room the next turn needed
			// breaks the session it claimed to help.
			const window = ctx.model?.contextWindow;
			const used = ctx.getContextUsage()?.tokens ?? undefined;
			const remaining = window !== undefined && used !== undefined ? Math.max(0, window - used) : undefined;
			const fullTokens = estimateTokens(fullText.length);
			// Zero remaining is not "unknown" — it is the worst case, and the one
			// place the severity must NOT quietly disappear.
			const share = remaining === undefined ? undefined : remaining > 0 ? fullTokens / remaining : Number.POSITIVE_INFINITY;

			const fullLabel =
				share === undefined
					? `full transcript — ~${fullTokens.toLocaleString()} tokens`
					: share === Number.POSITIVE_INFINITY
						? `full transcript — ~${fullTokens.toLocaleString()} tokens (no context left)`
						: `full transcript — ~${fullTokens.toLocaleString()} tokens (${Math.round(share * 100)}% of remaining context)`;
			const mode = await ctx.ui.select(`Bring it in as…`, [`summary — distilled by the cheap-role model`, fullLabel]);
			if (mode === undefined) return;

			const name = (row.name?.trim() || row.firstMessage.trim() || row.id.slice(0, 8)).replace(/\s+/g, " ").slice(0, 64);
			const header: ReferenceHeader = {
				name,
				id: row.id,
				date: row.modified.toISOString().slice(0, 10),
				// The REFERENCED session's cwd — provenance for the model, which may
				// be reading about work done in another project entirely.
				cwd: row.cwd,
				mode: mode === fullLabel ? "full" : "summary",
			};

			let body: string;
			let dropped = 0;
			if (header.mode === "full") {
				// The cap is a floor-bounded share of what is LEFT: the fraction
				// keeps room for the next turn, and the floor keeps a confirmed
				// injection coherent when almost nothing is left — at the stated
				// price of forcing compaction.
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
					"Inject the full transcript?",
					`~${estimateTokens(transcript.text.length).toLocaleString()} tokens of flattened conversation (messages and tool-call lines; tool results are not replayed).${fitNote} ` +
						`It becomes part of this session's context and re-costs on every future turn.${severityNote}`,
				);
				if (!confirmed) return;
				body = transcript.text;
			} else {
				const summary = await summarize(ctx, entries, agentDir, ctx.signal, (spend) =>
					pi.events.emit(SPEND_CHANNEL, { source: "session-ref", usage: spend, calls: 1 }),
				);
				if (!summary.ok) {
					ctx.ui.notify(`Couldn't summarise that session: ${summary.reason}`, "warning");
					return;
				}
				body = summary.text;
			}

			const block = referenceBlock(header, body);
			const details: RefDetails = {
				mode: header.mode,
				name,
				sessionId: row.id,
				date: header.date,
				tokens: estimateTokens(block.length),
				dropped,
			};

			// The content is what the model reads; the renderer is what the user
			// sees. No turn is triggered — the reference waits for whatever the
			// user asks next.
			pi.sendMessage<RefDetails>({ customType: MESSAGE_TYPE, content: block, display: true, details }, { triggerTurn: false });
			ctx.ui.notify(`Referenced "${name}" (${header.mode}, ~${details.tokens.toLocaleString()} tokens).`, "info");
		},
	});
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

	registerRefCommand(pi, {
		list: async (cwd) => toRows(await SessionManager.list(cwd)),
		listAll: async () => toRows(await SessionManager.listAll()),
	});
}
