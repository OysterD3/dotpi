/**
 * /rewind — restore the code and/or conversation to an earlier point.
 *
 * A port of Claude Code's `/rewind`, whose behaviour was read out of the shipped
 * binary (2.1.217) rather than inferred: the three modes and their exact labels,
 * the aliases (`checkpoint`, `undo`), keying checkpoints to submitted prompts,
 * treating "file absent at that point" as "delete it now", and refusing to touch
 * anything that is not a plain regular file.
 *
 * pi already has half of this. `/fork` and `/tree` navigate the session tree, and
 * `ctx.fork(id, { position: "before" })` restores the prompt into the editor —
 * that *is* conversation rewind, so this extension calls it rather than
 * reimplementing it. What pi has no answer for is code: its own docs say to "use
 * git or another checkpointing workflow if you want easy rollback". So the file
 * history here is the new part, and it is deliberately git-independent — it works
 * in a repo, outside one, and on files git ignores.
 *
 *   history.ts   the checkpoint model and its queries (pure)
 *   store.ts     content-addressed blobs and the on-disk index
 *   restore.ts   applying a code rewind, with the refuse-rather-than-force rules
 *   render.ts    picker rows and result summaries (pure)
 *   config.ts    tracked tools, size caps, retention
 *
 * Known limit: only `write` and `edit` are checkpointed. Files changed by `bash`
 * are invisible to this, because a shell command's effects cannot be known in
 * advance. A rewind will not undo them, and does not claim to.
 */

import { basename } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG, MODES, type RestoreMode } from "./config.ts";
import { buildRewindPoints, resolveTargets, type RewindPoint } from "./history.ts";
import { pickerLabel, summarize } from "./render.ts";
import { applyRestore } from "./restore.ts";
import { HistoryStore } from "./store.ts";

/** Session files are named `<timestamp>_<uuid>.jsonl`; the id is the uuid. */
function sessionIdFromFile(file: string): string | undefined {
	const stem = basename(file).replace(/\.jsonl$/, "");
	const id = stem.split("_").pop();
	return id && id.length > 0 ? id : undefined;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let store: HistoryStore | undefined;

	pi.on("session_start", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();

		// A rewind forks the session, so without this the new session would start
		// with no history and could never be rewound again.
		if (event.previousSessionFile) {
			const previous = sessionIdFromFile(event.previousSessionFile);
			if (previous && previous !== sessionId) HistoryStore.inherit(agentDir, previous, sessionId);
		}

		store = new HistoryStore(agentDir, sessionId);
		if (event.reason === "startup") HistoryStore.prune(agentDir);
	});

	// A checkpoint is one submitted prompt. pi emits this *before* appending the
	// user message, so the current leaf is that message's parent-to-be — the exact
	// link used later to find the entry to fork from.
	pi.on("before_agent_start", (event, ctx) => {
		if (!store) return;
		const history = store.get();
		history.checkpoints.push({
			seq: store.nextSeq(),
			prompt: event.prompt,
			at: Date.now(),
			parentId: ctx.sessionManager.getLeafEntry()?.id ?? null,
		});
		store.save();
	});

	// Record what a file looked like *before* each mutation. Runs before the tool
	// executes, which is the only moment the previous contents still exist.
	pi.on("tool_call", (event) => {
		if (!store) return;

		const pathParam = CONFIG.trackedTools[event.toolName];
		if (!pathParam) return;

		const path = (event.input as Record<string, unknown>)[pathParam];
		if (typeof path !== "string" || path.length === 0) return;

		const history = store.get();
		const captured = store.capture(path);
		history.edits.push({
			seq: store.nextSeq(),
			path,
			blob: captured.blob,
			...(captured.skipped ? { skipped: captured.skipped } : {}),
		});
		store.save();
	});

	const handler = async (_args: string, ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]) => {
		if (!store) return;

		if (!ctx.hasUI) {
			ctx.ui.notify("/rewind needs an interactive session", "warning");
			return;
		}

		const points = buildRewindPoints(store.get(), ctx.sessionManager.getBranch()).slice(
			-CONFIG.maxCheckpointsShown,
		);

		if (points.length === 0) {
			ctx.ui.notify("Nothing to rewind to yet", "info");
			return;
		}

		// Newest first: rewinding is almost always about undoing recent work.
		const ordered = [...points].reverse();
		const labels = ordered.map((point, index) => pickerLabel(point, index));

		const picked = await ctx.ui.select("Rewind to which point?", labels);
		if (picked === undefined) return;

		const point = ordered[labels.indexOf(picked)];
		if (!point) return;

		const mode = await chooseMode(ctx, point);
		if (mode === undefined) return;

		if (mode === "code" || mode === "both") {
			const targets = resolveTargets(store.get().edits, point.checkpoint.seq);
			const outcome = applyRestore(store, targets);
			ctx.ui.notify(summarize(outcome, ctx.cwd), outcome.refused.length > 0 ? "warning" : "info");
		}

		// Last, because forking replaces the session and invalidates this context.
		if (mode === "conversation" || mode === "both") {
			await ctx.fork(point.entryId, { position: "before" });
		}
	};

	// Claude Code's aliases, kept so muscle memory carries over.
	for (const name of ["rewind", "checkpoint", "undo"]) {
		pi.registerCommand(name, {
			description: "Restore the code and/or conversation to a previous point",
			handler,
		});
	}
}

/** Offer code restore only when there is code to restore, as Claude Code does. */
async function chooseMode(
	ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined> } },
	point: RewindPoint,
): Promise<RestoreMode | undefined> {
	const available = point.changed.length > 0 ? MODES : MODES.filter((m) => m.value === "conversation");

	if (available.length === 1) return available[0].value;

	const labels: string[] = available.map((m) => m.label);
	const picked = await ctx.ui.select("Restore what?", labels);
	if (picked === undefined) return undefined;

	return available[labels.indexOf(picked)]?.value;
}
