/**
 * The review angles: the distinct lenses a reviewer is asked to look through.
 *
 * Angles exist because a single "find the bugs" instruction produces one kind
 * of finding — whatever the model notices first — and then stops. Naming the
 * lens changes what gets seen: a pass that only asks "what did this diff
 * delete, and where was that invariant re-established?" finds a class of bug
 * that a line-by-line read reliably walks past.
 *
 * Two families. CLEANUP angles judge quality and never report crashes; their
 * cost is duplication, waste, or maintenance burden. CORRECTNESS angles look
 * for defects. They are kept apart because mixing them makes a reviewer trade
 * one against the other, and a style nit should never displace a real bug.
 *
 * Text only: which level runs which lens lives in config.ts, so this file has
 * no imports and nothing here has to know an effort level exists.
 */

/** Quality angles. /simplify uses these four; /code-review adds them after correctness. */
export const CLEANUP = {
	reuse: `### Reuse

Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.
`,

	simplification: `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.
`,

	efficiency: `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.
`,

	altitude: `### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.
`,

	/**
	 * Project conventions. pi loads AGENTS.md (and CLAUDE.md) as context files,
	 * nearest-first, so a directory's file governs the files at or below it.
	 */
	conventions: `### Conventions (AGENTS.md)

Find the guidance files that govern the changed code: your user-level
~/.pi/AGENTS.md, the repo-root AGENTS.md, plus any AGENTS.md or CLAUDE.md in a
directory that is an ancestor of a changed file (a directory's file only
applies to files at or below it). Read each one that exists, then check the
diff for clear violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line
that breaks it — no style preferences, no vague "spirit of the doc"
inferences. In the finding, name the file path and quote the rule so the
report can cite it. If no guidance file applies, return nothing for this angle.
`,
} as const;

/** The four cleanup angles /simplify runs, in order. */
export const SIMPLIFY_ANGLES = [CLEANUP.reuse, CLEANUP.simplification, CLEANUP.efficiency, CLEANUP.altitude];

/**
 * Correctness angles, hardest-to-see last.
 *
 * A is the obvious pass everyone does. B through E are the ones that pay:
 * each is defined by what it forces you to look at rather than what you happen
 * to notice, which is why they are worded as procedures, not topics.
 */
export const CORRECTNESS = {
	lineByLine: `### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the
change re-exposes or fails to fix them). For every line ask: what input, state,
timing, or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.
`,

	removedBehavior: `### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.
`,

	crossFile: `### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same diff make a call unsafe?
`,

	languagePitfalls: `### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.
`,

	wrappers: `### Angle E — wrapper/proxy correctness

When the diff adds or modifies a type that wraps another (cache, proxy,
decorator, adapter): check that every method routes to the wrapped instance and
not back through a registry/session/global — e.g. a caching provider holding a
\`delegate\` field that resolves ids via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.
`,
} as const;
