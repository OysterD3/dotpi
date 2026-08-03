/**
 * The process-wide ceiling and its fairness.
 *
 * Every assertion here is about a property that only appears under concurrency,
 * so the tasks are real promises resolved in a controlled order rather than
 * timers — a timing-based test of a scheduler tells you about the machine it
 * ran on.
 *
 * Run: node --experimental-transform-types agent/extensions/ultracode/scheduler.test.ts
 */
import { FairScheduler } from "./scheduler.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

/**
 * Let every pending microtask settle.
 *
 * Admitting a waiter is a chain of them — the finishing task resumes, its
 * finally releases, dispatch resolves the waiter's acquire, and only then does
 * the waiter's body run — so a fixed one or two `await Promise.resolve()` counts
 * ticks rather than waiting for quiescence, and reads as a scheduler bug when it
 * is really a test that looked too early.
 */
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A task that blocks until told to finish. */
function gate() {
	let release!: () => void;
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { done, release };
}

console.log("--- the ceiling holds ---");
{
	const scheduler = new FairScheduler(3);
	const gates = Array.from({ length: 6 }, gate);
	const started: number[] = [];
	const runs = gates.map((g, i) =>
		scheduler.run("run-a", async () => {
			started.push(i);
			await g.done;
		}),
	);
	await flush();
	check("only the limit start", started.length, 3);
	check("and it knows it is at capacity", scheduler.running, 3);
	check("with the rest queued", scheduler.waiting, 3);

	gates[0]!.release();
	await flush();
	check("finishing one admits exactly one", started.length, 4);

	for (const g of gates) g.release();
	await Promise.all(runs);
	check("everything ran", started.length, 6);
	check("nothing is left running", scheduler.running, 0);
	check("peak never exceeded the ceiling", scheduler.peakConcurrency, 3);
}

console.log("\n--- one run cannot starve another ---");
{
	// The scenario that makes a plain FIFO wrong: a big sweep is already queued
	// when you start a small second workflow. Under FIFO the small one waits for
	// the entire sweep.
	const scheduler = new FairScheduler(1);
	const order: string[] = [];
	const gates: Array<ReturnType<typeof gate>> = [];

	const submit = (runId: string, tag: string) => {
		const g = gate();
		gates.push(g);
		return scheduler.run(runId, async () => {
			order.push(tag);
			await g.done;
		});
	};

	const all = [submit("sweep", "sweep-1"), submit("sweep", "sweep-2"), submit("sweep", "sweep-3"), submit("small", "small-1")];
	await flush();
	check("the first submitted starts", order, ["sweep-1"]);

	// Release in turn; the small run must not be last.
	for (let i = 0; i < 4; i++) {
		gates[i]!.release();
		await flush();
	}
	await Promise.all(all);
	check("the small run is not stuck behind the whole sweep", order.indexOf("small-1") < 3, true);
	check("and the sweep keeps its own order", order.filter((t) => t.startsWith("sweep")), ["sweep-1", "sweep-2", "sweep-3"]);
}

console.log("\n--- a failing task releases its slot ---");
{
	// A leaked slot degrades the ceiling into a deadlock, one failure at a time,
	// which is why release is in a finally rather than after the await.
	const scheduler = new FairScheduler(1);
	const outcome = await scheduler.run("r", async () => {
		throw new Error("boom");
	}).then(() => "resolved", (error) => (error as Error).message);
	check("the error propagates", outcome, "boom");
	check("and the slot came back", scheduler.running, 0);
	const after = await scheduler.run("r", async () => "ok");
	check("so the next task can run", after, "ok");
}

console.log("\n--- a single run is not throttled below the ceiling ---");
{
	// The property the cap removal was protecting: breadth stays free to ask for
	// within one run. Thirty agents, ceiling of thirty-two, nothing queues.
	const scheduler = new FairScheduler(32);
	const gates = Array.from({ length: 30 }, gate);
	const runs = gates.map((g) => scheduler.run("wide", async () => await g.done));
	await flush();
	check("all thirty start at once", scheduler.running, 30);
	check("none queued", scheduler.waiting, 0);
	for (const g of gates) g.release();
	await Promise.all(runs);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
