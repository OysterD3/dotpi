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
	/** Spend extensions announced on SPEND_CHANNEL, one row per source. */
	announced?: Row[];
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

/** Fold one recorded usage block into `into`, counting it as one call. */
function record(into: Totals, usage: RecordedUsage | undefined): void {
	into.calls++;
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
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		toolName?: string;
		usage?: RecordedUsage;
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

function timestampOf(entry: EntryLike): number | undefined {
	if (!entry.timestamp) return undefined;
	const parsed = Date.parse(entry.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

export function collectUsage(entries: readonly unknown[]): SessionUsage {
	const models = new Map<string, Totals>();
	const tools = new Map<string, Totals>();
	const overhead = new Map<string, Totals>();
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
			// Only when pi actually recorded a call. A compaction an extension
			// performed itself has its spend on the extension's own messages, and
			// counting an empty entry would add a phantom call to the table.
			if (raw.usage) record(bucket(overhead, raw.type === "compaction" ? "compaction" : "branch summary"), raw.usage);
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
		// A tool result only carries usage when the tool spent on its own account.
		if (message.role === "toolResult" && message.usage) {
			record(bucket(tools, message.toolName ?? "tool"), message.usage);
		}
	}

	const total = emptyTotals();
	const modelRows = rows(models);
	const toolRows = rows(tools);
	const overheadRows = rows(overhead);
	for (const row of [...modelRows, ...toolRows, ...overheadRows]) addTotals(total, row.totals);

	return { models: modelRows, tools: toolRows, overhead: overheadRows, total, turns, failed, firstAt, lastAt };
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
}

/**
 * Running total of what extensions have announced, keyed by source.
 *
 * Increments rather than snapshots, so a producer announces as it spends and
 * never keeps a session-scoped tally of its own — and so two producers cannot
 * overwrite each other. Reset when the session is.
 */
export class AnnouncedSpendLog {
	private sources = new Map<string, Totals>();
	/** Per-source breakdown, keyed by the producer's `detail` label. */
	private details = new Map<string, Map<string, Totals>>();

	add(spend: AnnouncedSpend | undefined): void {
		if (!spend || typeof spend.source !== "string" || !spend.source) return;
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
	rows(): Row[] {
		return rows(this.sources).map((row) => {
			const within = this.details.get(row.label);
			// One child is the parent restated, so it earns no line.
			const children = within && within.size > 1 ? rows(within).map((child) => ({ label: child.label, totals: { ...child.totals } })) : undefined;
			return { label: row.label, totals: { ...row.totals }, ...(children ? { children } : {}) };
		});
	}
}

/**
 * Fold announced spend into a collected session.
 *
 * Kept out of collectUsage because it comes from events rather than the session
 * file, and because it must be visibly separable: this is the spend nothing in
 * the transcript can corroborate — workflow agents are other processes, and
 * recap and goal record their calls nowhere at all.
 */
export function withAnnounced(usage: SessionUsage, announced: Row[]): SessionUsage {
	if (announced.length === 0) return usage;
	const total = emptyTotals();
	addTotals(total, usage.total);
	for (const row of announced) addTotals(total, row.totals);
	return { ...usage, announced, total };
}
