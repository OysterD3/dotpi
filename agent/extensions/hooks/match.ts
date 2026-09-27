/**
 * Matcher strings, read the way Claude Code reads them. Pure.
 *
 *   ""  "*"  or absent            every value
 *   letters, digits, _ - space , |  an exact name, or a list split on | or ,
 *   anything else                 a JavaScript regex, unanchored
 *
 * The middle rule is the one people trip on and the reason this is not just
 * `new RegExp(matcher)`: `Edit|Write` is two exact names, so it does not match
 * `NotebookEdit`, while `Edit.*` is a regex and does. `mcp__memory` is an exact
 * name and matches nothing unless a tool is called exactly that. Matching is
 * case-sensitive, so `Bash` matches the bash tool and `bash` does not.
 *
 * StopFailure matches against a narrower exact-name set — no hyphen, space or
 * comma, and only `|` separates — which is that agent's rule for its error
 * types, kept so a matcher copied from its docs means the same thing here.
 */

export type Matcher =
	| { kind: "all" }
	| { kind: "exact"; names: ReadonlySet<string> }
	| { kind: "regex"; regex: RegExp };

const EXACT = /^[A-Za-z0-9_\- ,|]+$/;
const EXACT_NARROW = /^[A-Za-z0-9_|]+$/;

export function compileMatcher(matcher: string | undefined, narrow = false): Matcher | { error: string } {
	if (matcher === undefined || matcher === "" || matcher === "*") return { kind: "all" };
	if ((narrow ? EXACT_NARROW : EXACT).test(matcher)) {
		const names = matcher
			.split(narrow ? "|" : /[|,]/)
			.map((name) => name.trim())
			.filter((name) => name.length > 0);
		return { kind: "exact", names: new Set(names) };
	}
	try {
		return { kind: "regex", regex: new RegExp(matcher) };
	} catch (error) {
		return { error: `invalid regex "${matcher}": ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function matches(matcher: Matcher, value: string): boolean {
	switch (matcher.kind) {
		case "all":
			return true;
		case "exact":
			return matcher.names.has(value);
		case "regex":
			return matcher.regex.test(value);
	}
}
