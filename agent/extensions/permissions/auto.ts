/**
 * Auto mode: the session's classifier, its cache, and its books.
 *
 * ## The safety envelope, which is the whole design
 *
 * A model's opinion is being wired into a security control, and the model can be
 * argued with — that is what prompt injection *is*. So the classifier is placed
 * where being wrong is survivable:
 *
 *   - It is consulted **only** on calls the deterministic policy already decided
 *     to allow. `deny` rules, the destructive table, and `ask` rules all run
 *     first and none of them can be reached by it (see decide.ts).
 *   - Its only power is to **escalate an allow to an ask**. There is no verdict
 *     it can return that runs something the policy would have stopped.
 *
 * The floor that gives you: fully compromised, auto mode degrades to
 * `askDestructive` — the mode below it, and this repo's default. Working, it is
 * that plus a second opinion.
 *
 * Two limits on that claim, both found by review rather than by design, and both
 * worth stating here because the earlier version of this comment denied them:
 *
 *   - **It can cause a block, in exactly one place.** With no UI, an "ask"
 *     becomes whatever `askWithoutUi` says, and that defaults to `deny`. So in a
 *     headless run an `unsafe` verdict fails the tool call with no human to
 *     overrule it. That is the user's configured policy for asks rather than a
 *     power the classifier has on its own — but it does mean a false positive
 *     can fail a CI run, and `askWithoutUi: "allow"` is the way out.
 *   - **A session grant can still be widened by hand.** A classifier prompt
 *     offers "allow every <tool> call", and accepting it silences the classifier
 *     for that tool. It no longer silences the destructive table with it
 *     (grants.ts), which is what once put the session below the floor.
 *
 * ## Not paying for the same answer twice
 *
 * An agent runs the same command over and over: the test suite, the type check,
 * the same `git diff` after every edit. Verdicts are cached for the session on
 * the exact question text, and in-flight calls are cached as promises, so N
 * parallel tool calls of the same command make one request rather than N.
 *
 * Only terminal verdicts are cached. An error or an abort is dropped so the next
 * attempt re-asks: caching "the network was down" would silently disable the
 * mode for the rest of the session.
 *
 * Nothing is persisted. Like grants, a verdict dies with the session — a
 * standing "this command is fine" belongs in `allow`, where it is auditable, not
 * in a cache file that accumulates invisibly.
 */

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, selectModel, type Spend } from "./classify.ts";
import { AUTO } from "./config.ts";
import { resolveRole } from "./model.ts";
import { buildQuestion } from "./prompt.ts";
import type { AutoSettings } from "./settings.ts";
import type { Verdict } from "./verdict.ts";

export type AutoStats = {
	/** Calls that reached the model. */
	calls: number;
	safe: number;
	unsafe: number;
	errors: number;
	/** Calls answered from the session cache, i.e. money not spent. */
	cached: number;
	cost: number;
	tokens: number;
};

export class AutoClassifier {
	private readonly cache = new Map<string, Promise<Verdict>>();
	private readonly stats: AutoStats = { calls: 0, safe: 0, unsafe: 0, errors: 0, cached: 0, cost: 0, tokens: 0 };

	/**
	 * First failure of the session, kept so index.ts can report a degraded mode
	 * once instead of on every call. A classifier that is down is down for the
	 * rest of the session in almost every case, and repeating the warning would
	 * bury the transcript.
	 */
	private reported = false;

	/**
	 * The last resolved `permissions.auto.model`, so the lookup happens once.
	 *
	 * Resolving copies the whole model registry — about 1150 entries — and walks
	 * it up to four times building lower-cased strings, which measures at
	 * 0.08–0.18ms and several thousand transient strings *per classified tool
	 * call*, for an answer that only changes when the setting does. `clear()`
	 * drops it, and clear() already fires on exactly the events that can
	 * invalidate it: session start, `/permissions reload`, and every mode change.
	 *
	 * Only a configured reference is cached. With none set the answer is
	 * `ctx.model`, which the user can change under us at any time with the model
	 * selector, so that path stays a live read.
	 */
	private resolved?: { reference: string; model: NonNullable<ExtensionContext["model"]> };

	constructor(private readonly onSpend?: (spend: Spend) => void) {}

	/**
	 * Judge one tool call.
	 *
	 * `settings` is passed per call rather than held, because `/permissions
	 * reload` rebuilds the policy and the next judgement should use the new one.
	 */
	async judge(
		ctx: ExtensionContext,
		tool: string,
		input: Record<string, unknown>,
		settings: AutoSettings,
	): Promise<Verdict> {
		return this.ask(ctx, buildQuestion(tool, input, ctx.cwd), settings);
	}

	/** Which model to ask, resolving `permissions.auto.model` at most once. */
	private modelFor(ctx: ExtensionContext, settings: AutoSettings): { model: NonNullable<ExtensionContext["model"]> } | { error: string } {
		if (!settings.model) return ctx.model ? { model: ctx.model } : { error: "no model selected" };

		// The role is mapped on every call, and the expensive part — walking the
		// registry — is what gets memoised, keyed on the mapped reference. That
		// ordering is what lets `/provider` take effect mid-session: caching the
		// role name instead would keep answering from the old provider's model
		// until the next reload, which is exactly the half-applied state that
		// gets blamed on the model rather than on the config.
		const reference = resolveRole(settings.model, getAgentDir());
		if (this.resolved?.reference === reference) return { model: this.resolved.model };

		const picked = selectModel(ctx, reference);
		if ("model" in picked) this.resolved = { reference, model: picked.model };
		return picked;
	}

	/** The same path `/permissions classify <command>` takes, so it tests the real thing. */
	async ask(ctx: ExtensionContext, question: string, settings: AutoSettings): Promise<Verdict> {
		// Resolved before the cache is consulted, because the model is part of the
		// key. Counted as a failed call when it cannot be: a misconfigured
		// `auto.model` is exactly the case /permissions auto exists to make
		// visible, and silence would show a session that classified nothing and
		// never said why.
		const picked = this.modelFor(ctx, settings);
		if ("error" in picked) {
			this.stats.calls++;
			this.stats.errors++;
			return { kind: "error", reason: picked.error };
		}

		// The model is in the key, not just the question. With no `auto.model` set
		// the classifier runs on the session model, which the user can change at
		// any time — often *because* they want a better judge. Keying on the
		// question alone kept serving the old model's verdict and the stronger one
		// was never asked.
		const key = `${picked.model.provider}/${picked.model.id}\u0000${question}`;

		const hit = this.cache.get(key);
		if (hit) {
			this.stats.cached++;
			return hit;
		}

		const pending = classify(ctx, question, {
			model: picked.model,
			timeoutMs: settings.timeoutMs,
			// The agent's own abort signal. Esc during a classifier call cancels the
			// call, and an aborted verdict blocks — the tool call is being cancelled
			// anyway, and "the user pressed stop" must never read as "approved".
			signal: ctx.signal,
			onSpend: (spend) => {
				this.stats.cost += spend.cost;
				// Cache reads and writes count. The ~4KB system prompt is identical on
				// every call, so with prompt caching nearly all of the input arrives as
				// cacheRead — summing only input+output reported a fraction of what was
				// billed, and disagreed with /usage, which sums all four for the same
				// payload. Cheaper-looking is the one direction this must not be wrong in.
				this.stats.tokens += spend.input + spend.output + spend.cacheRead + spend.cacheWrite;
				this.onSpend?.(spend);
			},
		});

		this.cache.set(key, pending);

		let verdict: Verdict;
		try {
			verdict = await pending;
		} catch (error) {
			// classify() is written not to throw, but a permission gate is the wrong
			// place to find out that it does. An unexpected throw is an error verdict,
			// which onError then handles — it is never an approval.
			this.cache.delete(key);
			this.stats.calls++;
			this.stats.errors++;
			return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
		}

		this.stats.calls++;
		if (verdict.kind === "safe") this.stats.safe++;
		else if (verdict.kind === "unsafe") this.stats.unsafe++;
		else this.stats.errors++;

		// Errors and aborts are not answers, so they are not remembered.
		if (verdict.kind === "safe" || verdict.kind === "unsafe") this.evict();
		else this.cache.delete(key);

		return verdict;
	}

	/** Keep the cache bounded. Map iterates in insertion order, so this is FIFO. */
	private evict(): void {
		while (this.cache.size > AUTO.cacheEntries) {
			const oldest = this.cache.keys().next();
			if (oldest.done) return;
			this.cache.delete(oldest.value);
		}
	}

	/** True the first time it is called after a failure — the "report this once" latch. */
	shouldReport(): boolean {
		if (this.reported) return false;
		this.reported = true;
		return true;
	}

	snapshot(): AutoStats {
		return { ...this.stats };
	}

	clear(): number {
		const count = this.cache.size;
		this.cache.clear();
		this.reported = false;
		// Dropped with the verdicts: a reload may have pointed auto.model somewhere
		// else, and a cached resolution would keep asking the old one.
		this.resolved = undefined;
		return count;
	}
}
