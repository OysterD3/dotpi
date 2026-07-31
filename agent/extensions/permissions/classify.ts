/**
 * One classifier call: ask a model whether a single tool call is safe to run.
 *
 * The shape follows goal/judge.ts, for the same reasons. pi's stream options
 * carry no provider-level JSON schema, so the contract is enforced here: the
 * prompt demands bare JSON, and the response is parsed leniently and then
 * validated. Anything that fails validation is an **error**, never a silent
 * "safe" — a classifier that cannot be understood must not be able to clear a
 * command.
 *
 * A provider rejection is not an exception. `completeSimple` resolves with an
 * assistant message carrying `stopReason: "error"` (or `"aborted"`) and the
 * provider's text in `errorMessage`; only transport-level failures throw. So
 * every outcome is read off the resolved value, and the order that read happens
 * in is load-bearing: an abort wins over everything, because a cancelled call
 * can carry a complete JSON object followed by truncated prose, and parsing that
 * would let Esc register as an approval.
 *
 * What this file deliberately does NOT do is decide anything, or parse anything.
 * It returns a verdict; verdict.ts reads the model's answer into one (pure, so
 * it is tested without a provider), auto.ts turns a verdict into a behaviour,
 * and index.ts turns a behaviour into a prompt. The blast radius of a wrong
 * verdict is bounded by construction — see auto.ts.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTO } from "./config.ts";
import { resolveModel } from "./model.ts";
import { SYSTEM } from "./prompt.ts";
import { readVerdict, toVerdict, type Verdict } from "./verdict.ts";

/** Tokens and cost from one call, for the `usage:spend` channel. */
export type Spend = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };

/** Pick the model the classifier runs on: `permissions.auto.model` if set. */
export function selectModel(
	ctx: ExtensionContext,
	reference: string | undefined,
): { model: NonNullable<ExtensionContext["model"]> } | { error: string } {
	if (reference) {
		const resolved = resolveModel(reference, ctx.modelRegistry.getAll());
		if (resolved.ok) return { model: resolved.model };
		return { error: resolved.error };
	}
	if (ctx.model) return { model: ctx.model };
	return { error: "no model selected" };
}

export type ClassifyOptions = {
	/**
	 * The model to ask, already resolved.
	 *
	 * Resolution happens in auto.ts rather than here because it is worth caching
	 * and this file has nowhere to cache it: `selectModel` copies the whole
	 * registry (~1150 models) and walks it up to four times, lowercasing as it
	 * goes, which is not work to repeat in front of every tool call. auto.ts owns
	 * the session lifetime and therefore the only correct place to invalidate.
	 */
	model: NonNullable<ExtensionContext["model"]>;
	timeoutMs: number;
	signal?: AbortSignal;
	onSpend?: (spend: Spend) => void;
};

/** Ask the model about one already-rendered question (see prompt.ts). */
export async function classify(
	ctx: ExtensionContext,
	question: string,
	options: ClassifyOptions,
): Promise<Verdict> {
	const model = options.model;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { kind: "error", reason: auth.error };

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				reasoning: AUTO.reasoning,
			},
		);

		// Announced before any verdict is returned: every branch below is the
		// outcome of a call that was already billed, including the failed ones.
		options.onSpend?.({
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
			cacheRead: response.usage?.cacheRead ?? 0,
			cacheWrite: response.usage?.cacheWrite ?? 0,
			reasoning: response.usage?.reasoning ?? 0,
			cost: response.usage?.cost?.total ?? 0,
		});

		// (1) An interrupted call is not evidence of anything, whatever it emitted
		// before it stopped.
		if (response.stopReason === "aborted" || options.signal?.aborted) return { kind: "aborted" };

		// (2) A response we can read is a verdict.
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const parsed = readVerdict(text);
		if (parsed.kind !== "error") return parsed;

		// (3) Nothing readable. Context overflow is not diagnosed separately the way
		// goal does it: the question is a few hundred characters and cannot overflow
		// anything, so a provider that rejects it has a real problem worth reporting.
		if (response.stopReason === "error") {
			return { kind: "error", reason: response.errorMessage?.trim() || "classifier call failed" };
		}
		return toVerdict(undefined);
	} catch (error) {
		// Only transport-level failures reach here: timeout, socket, timeoutMs.
		if (options.signal?.aborted) return { kind: "aborted" };
		return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
	}
}
