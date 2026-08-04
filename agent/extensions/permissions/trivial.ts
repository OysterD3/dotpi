/**
 * Trivially safe bash commands: the ones auto mode should never pay a model to
 * judge, and — worse — never let a conservative cheap model turn into a prompt.
 *
 * The complaint this answers: auto mode kept asking about `printf` and `echo`.
 * Every distinct bash command that no allow rule matches is a classifier call,
 * and a cheap classifier judging a compound one-liner errs toward "unsafe" —
 * so the commands an agent runs most (print a banner, echo a marker between
 * steps) were the ones that prompted. The fix is the same shape as the
 * destructive table on the other side: deterministic, readable, auditable. You
 * can read TRIVIAL below and know exactly what will never be looked at.
 *
 * ## Why this is safe to put in front of the classifier
 *
 * This produces an allow at step 5 of the precedence order (see decide.ts), so
 * everything protective has already run: deny rules, the destructive table, ask
 * rules. `echo hi; rm -rf /` never gets here — the table caught it at step 2.
 * What remains is the classifier's own territory, and there this list is
 * strictly narrower than what an allow rule could say: an allow rule is a
 * string prefix, this is a whole-command grammar.
 *
 * The grammar is deliberately blunt, because blunt is checkable:
 *
 *   - Any `$` or backtick ANYWHERE — even quoted — rejects. Expansions can
 *     print credentials (`echo $AWS_SECRET_ACCESS_KEY`), substitutions run
 *     code, and telling the safe uses from the unsafe ones is a judgement
 *     call, which is precisely what this table exists to not make. Rejected
 *     commands are not blocked — they go to the classifier as before.
 *   - Any redirection rejects, except the exact stderr-housekeeping tokens
 *     (`2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`). `echo hi > file`
 *     writes a file, and where it lands is the classifier's question.
 *   - Every stage of every pipeline must *begin* with a listed command — no
 *     env-assignment prefixes, no wrappers, no paths. `FOO=bar echo hi` and
 *     `xargs rm` both fall through to the classifier.
 *
 * ## What is on the list, and what is deliberately not
 *
 * Listed: commands that print what the agent already wrote (echo, printf),
 * answer questions about the environment without opening files (pwd, date,
 * which, ls, wc, stat, file, du, df, …), and shell trivia (true, test, sleep).
 *
 * Not listed, on purpose:
 *
 *   - `cat`, `head`, `tail`, `less`, `sort`, `uniq`, `cut`, `grep` — content
 *     readers. `cat .env` prints credentials, and the deny rules that stop the
 *     read TOOL from opening `.env` do not reach a bash command. The classifier
 *     is exactly the right judge for "is reading *this* file fine".
 *   - `env`, `printenv`, `set` — credential printers by design.
 *   - `find` — `-delete` and `-exec` make it a deleter with extra steps.
 *   - wrappers (`xargs`, `time`, `env FOO=…`, `nohup`) — they launder the real
 *     command into argument position where this grammar will not look.
 *
 * `wc` and `stat` are the line: they open files but print only counts and
 * metadata, never contents. `tr` is stdin-only by design, and with every
 * producer stage on this list, its input is already trivial.
 *
 * Pure, so the whole grammar is testable as a table.
 */

import { splitSegments } from "./destructive.ts";

/** Commands trivially safe with any literal arguments. Keep alphabetical. */
const TRIVIAL = new Set([
	"[",
	":",
	"basename",
	"date",
	"df",
	"dirname",
	"du",
	"echo",
	"false",
	"file",
	"hostname",
	"id",
	"ls",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"seq",
	"sleep",
	"stat",
	"test",
	"tr",
	"true",
	"type",
	"uname",
	"wc",
	"which",
	"whoami",
]);

/**
 * Stream housekeeping that does not make a command a file write: `2>&1`,
 * `1>&2`, and the `/dev/null` redirects.
 *
 * Matched only as whole whitespace-delimited tokens, and that is load-bearing:
 * a substring strip of `2>&1` turned `echo hello2>&1backup` — which bash reads
 * as `>& 1backup`, a redirect that WRITES the file `1backup` — into
 * `echo hello backup`, and waved a file write through. A glued token is not
 * stripped, so its `>` survives to the scan below and rejects.
 */
const HARMLESS_REDIRECT = /(^|\s)(?:2>&1|1>&2|[12&]?>\/dev\/null)(?=\s|$)/g;

/**
 * Split one segment into pipeline stages on single unquoted `|`.
 *
 * splitSegments deliberately keeps pipelines whole (a pipeline is one logical
 * command to the destructive table), so the stage split happens here. `||` was
 * already consumed as a separator before this sees the text.
 */
export function splitPipeline(segment: string): string[] {
	const stages: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of segment) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "|") {
			stages.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	stages.push(current);
	return stages.map((stage) => stage.trim()).filter((stage) => stage.length > 0);
}

/** True when every character of `text` outside quotes passes `ok`. */
function scanUnquoted(text: string, ok: (char: string) => boolean): boolean {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of text) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (!ok(char)) return false;
	}
	return true;
}

/**
 * True when the command consists entirely of trivially safe stages.
 *
 * False means nothing except "not this table's business" — the caller sends it
 * to the classifier, exactly as it would have without this file.
 */
export function isTrivial(command: string): boolean {
	// Expansion and substitution reject wholesale, quoted or not. A `$` inside
	// single quotes is technically literal, but "technically" is doing the kind
	// of work this grammar refuses to do.
	if (command.includes("$") || command.includes("`")) return false;

	const segments = splitSegments(command);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		for (const rawStage of splitPipeline(segment)) {
			// Strip the harmless redirect tokens, then any remaining unquoted
			// redirection (or stray `&`, half of an unrecognised `&>` form) rejects.
			const stage = rawStage.replace(HARMLESS_REDIRECT, "$1");
			if (!scanUnquoted(stage, (char) => char !== ">" && char !== "<" && char !== "&")) return false;

			const head = stage.trim().split(/\s+/, 1)[0] ?? "";
			if (!TRIVIAL.has(head)) return false;
		}
	}

	return true;
}
