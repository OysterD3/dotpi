/**
 * Adding up what a session actually cost.
 *
 * The obvious version of this — sum the assistant messages — undercounts, and
 * it undercounts in the direction that matters. Three kinds of spend never
 * appear in an assistant message:
 *
 *   - tool-side calls. A tool result carries its own `usage` when the tool
 *     itself talked to a model (a synchronous workflow, a subagent). pi is
 *     explicit that this is "not part of main LLM context accounting", which is
 *     right for context and wrong for money.
 *   - context management. Compaction and branch summarisation are model calls
 *     pi makes on your behalf, recorded on the compaction/branch_summary entry
 *     rather than as messages.
 *   - extensions that call a model directly. Background workflow agents are
 *     separate pi processes; `recap` and `goal` call `completeSimple` and store
 *     only a display entry. None of it can be recovered from the file, so each
 *     announces on SPEND_CHANNEL and AnnouncedSpendLog keeps the tally.
 *   - the same, after a restart. An announcement is an event, so a `pi -c` into
 *     a session whose fleets ran yesterday inherits none of it — and the tool
 *     result a background run leaves behind is written before the money is
 *     spent, so the file cannot fill the gap either. A producer that keeps its
 *     own durable record answers COLLECT_CHANNEL at report time instead; see
 *     `AnnouncedSpend.key` for what stops that double-counting.
 *
 * Counted over every entry in the session FILE, not just the current branch: an
 * abandoned fork was still paid for, and a `/usage` that got cheaper when you
 * rewound would be lying.
 *
 * Pure — no session, no context, so the whole table is testable.
 */

/**
 * What a group of calls spent.
 *
 * Deliberately no `totalTokens`: on an assistant message that field is the
 * CONTEXT SIZE at that turn, not tokens billed, so summing it produces a large
 * number that means nothing. Context size is reported separately, from
 * getContextUsage(), where it is a current fact rather than an accumulation.
 */
export interface Totals {
	/**
	 * Model calls — round trips to a provider, wherever they happened.
	 *
	 * One meaning, in every row, and it took work to get there. The obvious
	 * reading of a tool result is "one call", and that is wrong by an order of
	 * magnitude for the tools that matter: a `wait: true` workflow arrives as a
	 * single tool result carrying the aggregate spend of a twenty-four agent
	 * fleet. Counting it as 1 put a `1` next to `$5.20` in the same column as a
	 * `3` next to `$3.30`, and made the Total row add round trips to tool
	 * invocations and call the sum a number of calls.
	 *
	 * So a tool that spends on its own account reports how many calls that was,
	 * on `details.turns`; see `callsFor`.
	 */
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Reasoning tokens, when the provider breaks them out. A subset of output. */
	reasoning: number;
	cost: number;
}

export interface Row {
	label: string;
	totals: Totals;
	/**
	 * Finer-grained rows under this one, when the producer named them: one
	 * workflow run, say, inside the `workflows` total. Rendered indented, and
	 * only when there is more than one — a single child just restates its parent.
	 */
	children?: Row[];
}

export interface SessionUsage {
	/** One row per provider/model that answered, costliest first. */
	models: Row[];
	/** One row per tool that spent on its own account, costliest first. */
	tools: Row[];
	/** Compaction and branch summarisation — pi's own calls. */
	overhead: Row[];
	/**
	 * Announced spend from sources that are not also tools, one row per source.
	 * An announcement matching a tool's name is merged into that tool's row
	 * instead — see withAnnounced.
	 */
	announced?: Row[];
	/**
	 * Whether anything in this report came from SPEND_CHANNEL, wherever it ended
	 * up. Drives the footnote, which has to stay true even when every
	 * announcement was merged into a tool row and `announced` is empty.
	 */
	hasAnnounced?: boolean;
	/**
	 * Keys (see `keyFor`) of the individual runs whose spend this report already
	 * took from the session FILE.
	 *
	 * A producer answering COLLECT_CHANNEL reports everything its own store
	 * holds, including runs that also recorded their usage on a tool result —
	 * it has no way to know what the transcript already says. This is the other
	 * half of that: the keys collected here are handed to
	 * `AnnouncedSpendLog.rows()` so those runs are dropped from the answer
	 * rather than billed twice.
	 */
	accountedKeys: string[];
	total: Totals;
	/** User messages, i.e. how many times you asked for something. */
	turns: number;
	/** Assistant messages that ended in an error or an interrupt. */
	failed: number;
	firstAt?: number;
	lastAt?: number;
}

export function emptyTotals(): Totals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

/** The usage block pi records on messages and on compaction entries. */
interface RecordedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	cost?: { total?: number };
}

export function addTotals(total: Totals, part: Totals): void {
	total.calls += part.calls;
	total.input += part.input;
	total.output += part.output;
	total.cacheRead += part.cacheRead;
	total.cacheWrite += part.cacheWrite;
	total.reasoning += part.reasoning;
	total.cost += part.cost;
}

/**
 * A finite number, or zero.
 *
 * Every field goes through this, not just `cost`. `usage:spend` is an open
 * channel and its payload arrives untyped, so one non-numeric token count would
 * turn an accumulator into a string via `+` — silently, and permanently for the
 * rest of the session, since every later add concatenates onto it.
 */
function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * How many model calls one tool result stands for.
 *
 * The convention, and it is a convention rather than something pi enforces: a
 * tool that spent on its own account puts the number of calls it made on
 * `details.turns`. Every spending tool in this repo already had that number to
 * hand — `subagents` and `advisor` were already reporting it, `ultracode` now
 * does — because each of them counts subagent turns to build the usage block in
 * the first place.
 *
 * It cannot travel on `usage`, which is the obvious place: pi's `Usage` has no
 * field for a call count, only tokens and cost. `details` is the only channel
 * that is both free-form and persisted to the session file, which is what lets
 * a resumed session still report the right number.
 *
 * Anything absent, zero, or not a positive integer falls back to one call. A
 * tool that spent money made at least one, and a fabricated larger number would
 * be worse than a conservative one.
 */
export function callsFor(details: unknown): number {
	if (!details || typeof details !== "object") return 1;
	const turns = (details as { turns?: unknown }).turns;
	return typeof turns === "number" && Number.isInteger(turns) && turns > 0 ? turns : 1;
}

/**
 * The name of the individual run behind one tool result, when it has one.
 *
 * The second half of the same convention as `details.turns`: `details.spendLabel`
 * is what an announcing producer would have put in `detail`, so a synchronous
 * run and a background one land under the same parent with the same kind of
 * label. Without it a merged row shows a breakdown that does not add up to its
 * own total — 16 of 40 accounted for — which is a worse report than no
 * breakdown at all.
 */
export function labelFor(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const label = (details as { spendLabel?: unknown }).spendLabel;
	return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

/**
 * The stable id of the run behind one tool result, when it has one.
 *
 * Third and last of the `details` conventions, and the one that keeps a durable
 * producer honest: `details.spendKey` says "this result already carries run X's
 * spend". The producer's own store also holds run X, and answering
 * COLLECT_CHANNEL it will offer it again — see `SessionUsage.accountedKeys`,
 * which is what stops that becoming two bills for one fleet.
 *
 * Distinct from `spendLabel`, which is for a human reading a row: two runs of
 * the same workflow in the same minute share a label and must not share a key.
 */
export function keyFor(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const key = (details as { spendKey?: unknown }).spendKey;
	return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/** Fold one recorded usage block into `into`, counting it as `calls` calls. */
function record(into: Totals, usage: RecordedUsage | undefined, calls = 1): void {
	into.calls += calls;
	if (!usage) return;
	into.input += num(usage.input);
	into.output += num(usage.output);
	into.cacheRead += num(usage.cacheRead);
	into.cacheWrite += num(usage.cacheWrite);
	into.reasoning += num(usage.reasoning);
	into.cost += num(usage.cost?.total);
}

/**
 * Every token the provider counted: fresh input, output, and both sides of the
 * cache. Cache reads ARE included — much cheaper per token, but not free, and
 * leaving them out would understate a long cached session by an order of
 * magnitude. The report prints the cache share beside this number, so the split
 * is visible rather than implied.
 */
export function billedTokens(totals: Totals): number {
	return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * Share of the input side served from cache, 0-100, or undefined when nothing
 * was sent at all. Worth surfacing because it is the difference between a long
 * session being affordable and not.
 */
export function cacheHitPercent(totals: Totals): number | undefined {
	const sent = totals.input + totals.cacheRead + totals.cacheWrite;
	if (sent === 0) return undefined;
	return (totals.cacheRead / sent) * 100;
}

/** Minimal shape of the entries this reads; pi's own types are structurally compatible. */
type EntryLike = {
	type: string;
	timestamp?: string;
	usage?: RecordedUsage;
	/** Free-form on a compaction entry; see hookCompactionUsage. */
	details?: unknown;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		toolName?: string;
		usage?: RecordedUsage;
		/** Free-form, tool-defined, and persisted. Read only for `turns`; see callsFor. */
		details?: unknown;
		stopReason?: string;
	};
};

function bucket(map: Map<string, Totals>, key: string): Totals {
	let totals = map.get(key);
	if (!totals) {
		totals = emptyTotals();
		map.set(key, totals);
	}
	return totals;
}

/** Costliest first; ties broken by tokens so a zero-cost provider still sorts sensibly. */
function rows(map: Map<string, Totals>): Row[] {
	return [...map.entries()]
		.map(([label, totals]) => ({ label, totals }))
		.sort((a, b) => b.totals.cost - a.totals.cost || billedTokens(b.totals) - billedTokens(a.totals) || a.label.localeCompare(b.label));
}

/**
 * Usage an extension reported for a compaction it performed itself.
 *
 * Read defensively: `details` is free-form and extension-owned, so every level
 * is checked and anything unexpected reads as "no spend to report" rather than
 * throwing inside the report. Only the nesting the one known producer uses is
 * understood; a different extension reporting a different shape is simply not
 * counted, which is the same outcome as today.
 */
export function hookCompactionUsage(details: unknown): RecordedUsage | undefined {
	if (!details || typeof details !== "object") return undefined;
	const remote = (details as { remoteCompaction?: unknown }).remoteCompaction;
	if (!remote || typeof remote !== "object") return undefined;
	const usage = (remote as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage as RecordedUsage;
}

function timestampOf(entry: EntryLike): number | undefined {
	if (!entry.timestamp) return undefined;
	const parsed = Date.parse(entry.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

export function collectUsage(entries: readonly unknown[]): SessionUsage {
	const models = new Map<string, Totals>();
	const tools = new Map<string, Totals>();
	/** Per-run breakdown within a tool, keyed by `details.spendLabel`. */
	const toolDetails = new Map<string, Map<string, Totals>>();
	const overhead = new Map<string, Totals>();
	/** Runs whose spend the file already accounts for; see accountedKeys. */
	const accounted = new Set<string>();
	let turns = 0;
	let failed = 0;
	let firstAt: number | undefined;
	let lastAt: number | undefined;

	for (const raw of entries as EntryLike[]) {
		if (!raw || typeof raw !== "object") continue;

		const at = timestampOf(raw);
		if (at !== undefined) {
			if (firstAt === undefined || at < firstAt) firstAt = at;
			if (lastAt === undefined || at > lastAt) lastAt = at;
		}

		if (raw.type === "compaction" || raw.type === "branch_summary") {
			// pi records `usage` when pi itself made the call. An extension that
			// compacts on its own account bills to its own key, so pi has nothing
			// to record and the entry arrives empty — counting that would add a
			// phantom call, hence the guard.
			//
			// But an extension CAN report what it spent, in `details`, and one
			// does: pi-openai-server-compaction talks to the Responses endpoint
			// itself and returns its usage under `details.remoteCompaction.usage`.
			// Without the fallback below, every server-side compaction in a
			// session is real money that never appears in the table and never
			// appears in Total — silently, because a missing row looks like a
			// session that simply never compacted.
			const spend = raw.usage ?? hookCompactionUsage(raw.details);
			if (spend) record(bucket(overhead, raw.type === "compaction" ? "compaction" : "branch summary"), spend);
			continue;
		}

		if (raw.type !== "message" || !raw.message) continue;
		const message = raw.message;

		if (message.role === "user") {
			turns++;
			continue;
		}
		if (message.role === "assistant") {
			record(bucket(models, `${message.provider ?? "?"}/${message.model ?? "?"}`), message.usage);
			if (message.stopReason === "error" || message.stopReason === "aborted") failed++;
			continue;
		}
		// A tool result only carries usage when the tool spent on its own account,
		// and when it did, one result can stand for many calls.
		if (message.role === "toolResult" && message.usage) {
			const name = message.toolName ?? "tool";
			const calls = callsFor(message.details);
			record(bucket(tools, name), message.usage, calls);
			// Only from a result that CARRIED usage. A background run's result is
			// written when the fleet starts and carries none, so keying off it
			// would mark the run accounted for and then drop the only report of
			// what it spent.
			const key = keyFor(message.details);
			if (key) accounted.add(key);
			const label = labelFor(message.details);
			if (label) {
				let within = toolDetails.get(name);
				if (!within) {
					within = new Map<string, Totals>();
					toolDetails.set(name, within);
				}
				record(bucket(within, label), message.usage, calls);
			}
		}
	}

	const total = emptyTotals();
	const modelRows = rows(models);
	const toolRows = rows(tools).map((row) => {
		const within = toolDetails.get(row.label);
		return within?.size ? { ...row, children: rows(within) } : row;
	});
	const overheadRows = rows(overhead);
	for (const row of [...modelRows, ...toolRows, ...overheadRows]) addTotals(total, row.totals);

	return { models: modelRows, tools: toolRows, overhead: overheadRows, total, turns, failed, firstAt, lastAt, accountedKeys: [...accounted] };
}

/**
 * One announcement on SPEND_CHANNEL: an INCREMENT of spend from one extension.
 *
 * `cost` is a plain number — pi's `Usage.cost.total`, flattened — where every
 * source read off the session file nests it under `{ total }`. Spelled out as
 * its own type because the two shapes are one keystroke apart and reading the
 * wrong one is silent: `usage.cost?.total` on a number is `undefined`, which
 * folds in as zero and reports a fleet that cost fifty dollars as free.
 */
export interface AnnouncedSpend {
	/** Row label, and the accumulation key: "workflows", "recap", "goal". */
	source: string;
	usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		reasoning?: number;
		/** Flat, not `{ total }`. */
		cost?: number;
	};
	/** Model calls this increment covers. Defaults to 1. */
	calls?: number;
	/**
	 * Optional finer label within `source` — the individual run, request or job
	 * this increment came from. Producers that have no meaningful subdivision
	 * omit it and get a single row.
	 */
	detail?: string;
	/**
	 * A stable id for the thing being reported — and, when present, a change of
	 * meaning: the payload is a SNAPSHOT of that thing's whole spend, replacing
	 * whatever was last said under the same key, rather than an increment.
	 *
	 * That is what lets a producer with a durable store answer COLLECT_CHANNEL
	 * on every report without the numbers growing each time it is asked, and
	 * what lets the same run be reported live from memory and later from disk
	 * and still be billed once. A producer that only ever streams increments
	 * (recap, goal, the permissions classifier) has nothing to key on and omits
	 * it.
	 */
	key?: string;
}

/**
 * Running total of what extensions have announced, keyed by source.
 *
 * Increments by default, so a producer announces as it spends and never keeps a
 * session-scoped tally of its own — and so two producers cannot overwrite each
 * other. Reset when the session is.
 *
 * A producer with a durable record of its own spend instead announces keyed
 * snapshots (see `AnnouncedSpend.key`), which replace rather than add. That is
 * the only shape that survives a restart: the increments here are events, and
 * `pi -c` starts from an empty log with nothing in the transcript to rebuild it
 * from.
 */
export class AnnouncedSpendLog {
	private sources = new Map<string, Totals>();
	/** Per-source breakdown, keyed by the producer's `detail` label. */
	private details = new Map<string, Map<string, Totals>>();
	/**
	 * Keyed SNAPSHOTS, per source: the latest word on each identified thing,
	 * kept apart from the increments above precisely because they replace rather
	 * than accumulate.
	 */
	private snapshots = new Map<string, Map<string, { detail?: string; totals: Totals }>>();

	add(spend: AnnouncedSpend | undefined): void {
		if (!spend || typeof spend.source !== "string" || !spend.source) return;

		if (typeof spend.key === "string" && spend.key) {
			let within = this.snapshots.get(spend.source);
			if (!within) {
				within = new Map<string, { detail?: string; totals: Totals }>();
				this.snapshots.set(spend.source, within);
			}
			// Replaced wholesale. A live run announcing its running total and the
			// same run read back off disk later are the same money said twice, and
			// the later word — whichever it is — is the one that is complete.
			const totals = emptyTotals();
			this.fold(totals, spend);
			within.set(spend.key, { detail: spend.detail, totals });
			return;
		}

		const totals = bucket(this.sources, spend.source);
		if (typeof spend.detail === "string" && spend.detail) {
			let within = this.details.get(spend.source);
			if (!within) {
				within = new Map<string, Totals>();
				this.details.set(spend.source, within);
			}
			this.fold(bucket(within, spend.detail), spend);
		}
		this.fold(totals, spend);
	}

	/**
	 * Add one announcement's numbers to a bucket.
	 *
	 * Coerced field by field inside `record`, not trusted: an unrecognised payload
	 * reports as zero rather than throwing mid-render or poisoning the
	 * accumulator. The end-to-end test against a real producer is what stops that
	 * zero going unnoticed.
	 */
	private fold(totals: Totals, spend: AnnouncedSpend): void {
		const before = totals.calls;
		record(totals, { ...spend.usage, cost: { total: num(spend.usage?.cost) } });
		// `record` counts one call; an announcement may cover several turns.
		totals.calls = before + (typeof spend.calls === "number" && spend.calls > 0 ? spend.calls : 1);
	}

	reset(): void {
		this.sources.clear();
		this.details.clear();
		this.snapshots.clear();
	}

	/**
	 * A SNAPSHOT: every Totals is copied on the way out.
	 *
	 * The rows go into a stored `/usage` entry that is re-rendered on every
	 * redraw, and this log keeps mutating its own Totals as spend arrives. Handing
	 * out the live objects made a scrolled-back report restate itself with today's
	 * numbers above a total that never moved — rows that no longer summed to their
	 * own footer, and, because pi defers persistence until the first assistant
	 * message, sometimes those mutated numbers written into the session file.
	 */
	rows(exclude?: ReadonlySet<string>): Row[] {
		// Built fresh on every call, so what goes out is a snapshot in the same
		// sense the old copy-on-the-way-out was: this log keeps mutating as spend
		// arrives, and a stored /usage entry re-renders long after.
		const totals = new Map<string, Totals>();
		const children = new Map<string, Map<string, Totals>>();
		const childBucket = (source: string, label: string): Totals => {
			let within = children.get(source);
			if (!within) {
				within = new Map<string, Totals>();
				children.set(source, within);
			}
			return bucket(within, label);
		};

		// Increments: the source total and its breakdown are two tallies of the
		// same money, so they are copied across separately rather than summed.
		for (const [source, part] of this.sources) addTotals(bucket(totals, source), part);
		for (const [source, within] of this.details) {
			for (const [label, part] of within) addTotals(childBucket(source, label), part);
		}

		// Snapshots: one entry per key, contributing to both, and skipped entirely
		// when the report says it already has that run from the session file.
		// Skipped BEFORE the bucket call, so a source whose every run was already
		// accounted for produces no row at all rather than an empty one.
		for (const [source, within] of this.snapshots) {
			for (const [key, snapshot] of within) {
				if (exclude?.has(key)) continue;
				addTotals(bucket(totals, source), snapshot.totals);
				if (snapshot.detail) addTotals(childBucket(source, snapshot.detail), snapshot.totals);
			}
		}

		return rows(totals).map((row) => {
			const within = children.get(row.label);
			// Every child is emitted, including a lone one. Whether it earns a line
			// is not knowable here: a single run restates its parent only if the
			// parent is nothing but that run, and after withAnnounced merges this
			// into a tool that also spent, it no longer is. The redundant-child rule
			// therefore lives where the finished parent exists — see pruneChildren.
			return within?.size ? { ...row, children: rows(within) } : row;
		});
	}
}

/**
 * Fold announced spend into a collected session.
 *
 * Kept out of collectUsage because it comes from events rather than the session
 * file: this is the spend nothing in the transcript can corroborate — workflow
 * agents are other processes, and recap and goal record their calls nowhere at
 * all.
 *
 * An announcement whose `source` matches a tool that already spent is merged
 * into that tool's row rather than added beside it. One producer reaching the
 * report by two routes is not two producers, and it used to read as two: a
 * `wait: true` workflow attaches its spend to the tool result, a background one
 * announces, and the same feature appeared as `workflow (tool)` and `workflows`
 * in different sections of the table — which of the two you got depending on a
 * parameter the report never showed, and a *failed* synchronous run switching
 * from one to the other because pi builds the error result itself and it
 * carries no usage. Merging on the shared name makes those one row, however the
 * numbers arrived.
 */
/**
 * Combine two breakdowns of the same row, folding on the run label.
 *
 * Same-labelled children are added rather than listed twice — a run that
 * somehow reported through both routes is still one run, and two lines with the
 * same name and half the money each would be the exact confusion this whole
 * change is removing.
 */
function mergeChildren(existing: Row[] | undefined, incoming: Row[]): Row[] {
	const byLabel = new Map<string, Totals>();
	for (const child of [...(existing ?? []), ...incoming]) {
		const totals = bucket(byLabel, child.label);
		addTotals(totals, child.totals);
	}
	return rows(byLabel);
}

/**
 * Make a row's breakdown either absent, or complete.
 *
 * Two failures live here, and both are about a reader trusting indented lines.
 *
 * A lone child that exactly restates its parent is a duplicate line: the same
 * figures twice, which reads as double the spend. The test is equality with the
 * parent rather than "there is only one of them", because that same single
 * child under a row that also absorbed a synchronous run's spend is a real
 * breakdown of a mixed total.
 *
 * The opposite failure is a breakdown that silently sums to LESS than its own
 * parent — a workflow result with no `spendLabel` (an older session, or a run
 * whose detail was never set) contributes to the parent but produces no child.
 * A reader adding up the indented lines then concludes the row cost less than
 * it did, which is the direction a cost report must never be wrong in. So the
 * remainder is given its own line instead of being left to be noticed.
 */
function reconcileChildren(row: Row): Row {
	const children = row.children;
	if (!children?.length) return row;

	if (children.length === 1) {
		const only = children[0]!;
		const restatesParent =
			only.totals.cost === row.totals.cost &&
			only.totals.calls === row.totals.calls &&
			billedTokens(only.totals) === billedTokens(row.totals);
		if (restatesParent) {
			const { children: _dropped, ...rest } = row;
			return rest;
		}
	}

	const counted = emptyTotals();
	for (const child of children) addTotals(counted, child.totals);

	const remainder: Totals = {
		calls: row.totals.calls - counted.calls,
		input: row.totals.input - counted.input,
		output: row.totals.output - counted.output,
		cacheRead: row.totals.cacheRead - counted.cacheRead,
		cacheWrite: row.totals.cacheWrite - counted.cacheWrite,
		reasoning: row.totals.reasoning - counted.reasoning,
		cost: row.totals.cost - counted.cost,
	};

	// Floating-point cost never lands exactly, so the gap has to be material in
	// something countable before it earns a line.
	if (remainder.calls <= 0 && billedTokens(remainder) <= 0) return row;

	return { ...row, children: [...children, { label: "(unnamed runs)", totals: remainder }] };
}

export function withAnnounced(usage: SessionUsage, announced: Row[]): SessionUsage {
	// Deliberately NOT short-circuited on an empty announcement list. The
	// reconcile pass below is the only thing that drops a duplicated child line,
	// and returning early skipped it for the commonest case there is: one
	// synchronous workflow and nothing announced at all. That printed the run's
	// figures twice, and whether it did depended on whether some unrelated
	// extension happened to spend money in the same session.

	// Copied before merging: these Totals belong to collectUsage's maps, and the
	// announced log hands out snapshots that callers may re-fold on a later
	// redraw. Mutating either in place makes a stored report restate itself.
	const tools = usage.tools.map((row) => ({
		...row,
		totals: { ...row.totals },
		...(row.children ? { children: row.children.map((child) => ({ ...child, totals: { ...child.totals } })) } : {}),
	}));
	const standalone: Row[] = [];

	for (const row of announced) {
		const merged = tools.find((tool) => tool.label === row.label);
		if (!merged) {
			standalone.push(row);
			continue;
		}
		addTotals(merged.totals, row.totals);
		// Both sides' breakdowns are combined, not one replaced by the other: a
		// merged row can hold synchronous runs (named on the tool result) and
		// background ones (named in the announcement), and showing only one set
		// gives children that do not add up to their own parent.
		if (row.children?.length) merged.children = mergeChildren(merged.children, row.children);
	}

	const total = emptyTotals();
	addTotals(total, usage.total);
	for (const row of announced) addTotals(total, row.totals);

	return {
		...usage,
		tools: tools.map(reconcileChildren).sort((a, b) => b.totals.cost - a.totals.cost || a.label.localeCompare(b.label)),
		announced: standalone.map(reconcileChildren),
		hasAnnounced: announced.length > 0,
		total,
	};
}
