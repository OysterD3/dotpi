/**
 * A process-wide ceiling on concurrent subagents, shared by every run.
 *
 * This is NOT the per-run throttle that was deliberately removed. That one
 * capped a single run at min(16, cores - 2) and made breadth expensive to ask
 * for; every peer implementation ships one, and every one of them copied the
 * number from Claude Code without recording any evidence for it. Nothing here
 * restores that.
 *
 * What it restores is a different property, and the reason the two got confused
 * is worth writing down. `/workflows` supports several runs at once, on purpose.
 * With no cap anywhere, N concurrent runs each fanning out to M agents spawn
 * N×M pi processes — each a full node process with a model connection — and
 * nothing anywhere is counting. That is not "a slow workflow", it is a fork
 * bomb with a progress bar.
 *
 * The per-run peakConcurrency recorded in run.json cannot see it either: it is
 * measured inside one run, so two runs peaking at eight apiece read as "8"
 * twice and the sixteen never appears in any field. There is no observation
 * that would have caught this short of the machine falling over.
 *
 * So: a high CEILING rather than a tight throttle. A single run fanning out to
 * thirty agents is unaffected, which keeps "breadth is free to ask for" true —
 * the thing the cap removal was protecting. Only the aggregate is bounded.
 *
 * Fairness is the other half. A plain FIFO would let one run's hundred-agent
 * sweep starve a two-agent run queued behind it for the entire sweep, which is
 * exactly the surprise someone hits when they start a quick second workflow.
 * Waiters are therefore dispatched round-robin ACROSS runs: each run's queue is
 * FIFO within itself, and the cursor moves on after every grant.
 */

/** A queued waiter: resolve to admit it. */
type Waiter = () => void;

export class FairScheduler {
	private active = 0;
	/** Per-run FIFO queues, keyed by runId. */
	private readonly queues = new Map<string, Waiter[]>();
	/** Runs with waiting agents, in the order they started waiting. */
	private readonly order: string[] = [];
	/** Where the round-robin resumes; an index into `order`. */
	private cursor = 0;
	private peak = 0;

	constructor(private readonly limit: number) {}

	/** The most agents that have run at once across every run in this process. */
	get peakConcurrency(): number {
		return this.peak;
	}

	/** How many are running right now. */
	get running(): number {
		return this.active;
	}

	/** How many are waiting for a slot, across all runs. */
	get waiting(): number {
		let total = 0;
		for (const queue of this.queues.values()) total += queue.length;
		return total;
	}

	/**
	 * Run `task` once a slot is free, and release the slot whichever way it
	 * ends.
	 *
	 * The release is in a finally rather than after the await: a task that
	 * throws — an aborted run, a dead spawn — must not hold a slot for the life
	 * of the process, which would degrade the ceiling into a deadlock one leak
	 * at a time.
	 */
	async run<T>(runId: string, task: () => Promise<T>): Promise<T> {
		await this.acquire(runId);
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private acquire(runId: string): Promise<void> {
		if (this.active < this.limit && this.waiting === 0) {
			// Fast path, and the `waiting === 0` half is load-bearing: admitting a
			// newcomer while others are queued would let a run that keeps starting
			// agents jump the queue indefinitely.
			this.active++;
			this.peak = Math.max(this.peak, this.active);
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const queue = this.queues.get(runId);
			if (queue) queue.push(resolve);
			else {
				this.queues.set(runId, [resolve]);
				this.order.push(runId);
			}
		});
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		this.dispatch();
	}

	/** Admit waiters, round-robin over runs, while slots remain. */
	private dispatch(): void {
		while (this.active < this.limit && this.order.length > 0) {
			if (this.cursor >= this.order.length) this.cursor = 0;
			const runId = this.order[this.cursor]!;
			const queue = this.queues.get(runId);
			const next = queue?.shift();

			if (!next) {
				// That run has nothing left waiting; drop it from the rotation.
				this.queues.delete(runId);
				this.order.splice(this.cursor, 1);
				continue;
			}

			this.active++;
			this.peak = Math.max(this.peak, this.active);
			next();
			// Move on BEFORE the next grant, so one run cannot take two slots in a
			// row while another waits.
			this.cursor++;
		}
	}
}
