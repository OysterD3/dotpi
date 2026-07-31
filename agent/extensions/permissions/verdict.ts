/**
 * Reading a classifier's answer. Pure — no pi APIs, no SDK, no network.
 *
 * Split out from classify.ts rather than living beside the call it belongs to,
 * for the reason destructive.ts is split from decide.ts: this is the part where
 * a mistake clears a dangerous command, so it must be testable without a
 * provider, a key, or a network. `auto.test.ts` imports this file; importing
 * classify.ts would drag the AI SDK into the test run.
 *
 * The asymmetry below is the whole contract. There is exactly one way to get a
 * clearance out of `toVerdict`: the model literally said `"safe": true`. Every
 * other input — a missing key, a truthy string, a number, prose, a truncated
 * response, nothing at all — is an *error*, and an error is never an approval.
 * A classifier that cannot be understood must not be able to wave a command
 * through.
 */

export type Verdict =
	| { kind: "safe"; reason: string }
	| { kind: "unsafe"; reason: string }
	/** Unreachable, unparseable, or misconfigured. Never treated as either answer. */
	| { kind: "error"; reason: string }
	/** The user interrupted. Not a failure, and not an approval. */
	| { kind: "aborted" };

/**
 * Every balanced brace run in a model response, in order, parsed.
 *
 * Models wrap JSON in prose or fences even when told not to, so the verdict has
 * to be found rather than assumed. The subtlety that matters here — and that an
 * earlier version got wrong — is that the FIRST brace run is very often not the
 * verdict. This classifier's whole subject matter is shell commands, and braces
 * are everywhere in them: `find -exec rm {} \;`, `awk '{print $1}'`, `jq`,
 * `${VAR}`. A model that prefaces its answer by quoting the command it judged —
 * which they routinely do — puts `{}` on screen before the JSON.
 *
 * Stopping at the first run made that response unreadable, and unreadable means
 * `error`, and the shipped `auto.onError: "allow"` runs an error. So a model
 * that correctly answered "recursively deletes source files" produced a silent
 * allow. Hence: yield every candidate and let the caller pick the one that is
 * actually a verdict.
 *
 * String literals are tracked so a brace inside a quoted reason does not end a
 * run, and a run that fails to parse is skipped rather than ending the scan.
 */
export function* jsonCandidates(raw: string): Generator<unknown> {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0) {
				try {
					yield JSON.parse(text.slice(start, i + 1));
				} catch {
					// Not JSON after all — keep scanning for the next run.
				}
			}
		}
	}
}

/** The first balanced brace run that parses, or undefined. */
export function extractJson(raw: string): unknown {
	for (const candidate of jsonCandidates(raw)) return candidate;
	return undefined;
}

/**
 * Read a model response into a Verdict.
 *
 * Tries every JSON object in the response and takes the first that is actually
 * a verdict, so prose containing `{}` cannot bury the answer. Only when none of
 * them is a verdict is the response an error.
 */
export function readVerdict(raw: string): Verdict {
	for (const candidate of jsonCandidates(raw)) {
		const verdict = toVerdict(candidate);
		if (verdict.kind !== "error") return verdict;
	}
	return toVerdict(undefined);
}

/** Validate a parsed object into a Verdict. See the file header for the contract. */
export function toVerdict(parsed: unknown): Verdict {
	// Arrays are objects in JavaScript, and `["safe"]` reaching the boolean check
	// below would simply fail it — but rejecting the shape here says why.
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "error", reason: "classifier did not return a JSON object" };
	}

	const record = parsed as Record<string, unknown>;
	if (typeof record.safe !== "boolean") {
		return { kind: "error", reason: "classifier response had no boolean 'safe'" };
	}

	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0
			? record.reason.trim()
			: "no reason given";

	return record.safe ? { kind: "safe", reason } : { kind: "unsafe", reason };
}
