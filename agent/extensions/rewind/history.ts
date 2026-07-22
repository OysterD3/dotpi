/**
 * The checkpoint model — pure, so the interesting logic is testable without a
 * session, a filesystem, or an agent.
 *
 * The scheme is Claude Code's, simplified in one place. Claude Code versions each
 * backup (`<hash>@v3`) and has later snapshots inherit pointers from earlier ones.
 * Here, blobs are content-addressed by digest, so two checkpoints that share a
 * file's contents share the blob automatically and no inheritance pass is needed.
 *
 * What gets recorded is the content of a file **before** each mutation. That is
 * what makes restoring cheap and correct: the state of a file at checkpoint C is
 * the "before" image of the first mutation at or after C, and if nothing has
 * touched it since C, the file on disk is already correct and is left alone.
 *
 * `blob: null` means the file did not exist at that point, so restoring deletes it.
 */

/** A file's contents immediately before one mutation. */
export type EditRecord = {
	seq: number;
	path: string;
	/** Digest of the pre-mutation contents, or null if the file did not exist. */
	blob: string | null;
	/** Set when the file was too large to back up; restore must refuse. */
	skipped?: "too-large" | "unreadable";
};

/** A point the user can rewind to: one submitted prompt. */
export type Checkpoint = {
	seq: number;
	prompt: string;
	at: number;
	/**
	 * Id of the leaf entry when the prompt was submitted — i.e. the `parentId` of
	 * the user message entry pi is about to append. pi emits `before_agent_start`
	 * before appending, so this is the only exact link available at that moment.
	 * `null` for the first prompt in a session.
	 */
	parentId: string | null;
};

export type History = {
	checkpoints: Checkpoint[];
	edits: EditRecord[];
	nextSeq: number;
};

export function emptyHistory(): History {
	return { checkpoints: [], edits: [], nextSeq: 1 };
}

/**
 * What each file must become to restore the tree to `seq`.
 *
 * For every path, the earliest mutation at or after `seq` holds the "before"
 * image we want. Paths with no mutation since `seq` are absent from the result:
 * they are already correct, and rewriting them would churn mtimes for nothing.
 */
export function resolveTargets(edits: EditRecord[], seq: number): Map<string, EditRecord> {
	const targets = new Map<string, EditRecord>();

	for (const edit of edits) {
		if (edit.seq < seq) continue;
		if (targets.has(edit.path)) continue; // earliest wins
		targets.set(edit.path, edit);
	}

	return targets;
}

/** Paths mutated at or after `seq` — what a rewind to that point would touch. */
export function changedSince(edits: EditRecord[], seq: number): string[] {
	return [...resolveTargets(edits, seq).keys()].sort();
}

export type BranchEntry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: { role?: string };
};

/** A checkpoint joined to the session entry it belongs to. */
export type RewindPoint = {
	checkpoint: Checkpoint;
	/** Entry id of the user message, for ctx.fork(). */
	entryId: string;
	/** Files a code restore would change. */
	changed: string[];
};

/**
 * Join checkpoints to the user-message entries they produced.
 *
 * The link is `checkpoint.parentId === entry.parentId`: both name the leaf that
 * preceded the prompt. Within a single branch that is unique, so this is an exact
 * match rather than a guess. Checkpoints from abandoned branches simply find no
 * entry and drop out, which is what we want after a previous rewind.
 */
export function buildRewindPoints(history: History, branch: BranchEntry[]): RewindPoint[] {
	const userEntries = branch.filter(
		(entry) => entry.type === "message" && entry.message?.role === "user",
	);

	const byParent = new Map<string | null, string>();
	for (const entry of userEntries) {
		if (!byParent.has(entry.parentId)) byParent.set(entry.parentId, entry.id);
	}

	const points: RewindPoint[] = [];
	for (const checkpoint of history.checkpoints) {
		const entryId = byParent.get(checkpoint.parentId);
		if (entryId === undefined) continue;
		points.push({
			checkpoint,
			entryId,
			changed: changedSince(history.edits, checkpoint.seq),
		});
	}

	return points;
}
