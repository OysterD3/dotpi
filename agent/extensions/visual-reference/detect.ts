/**
 * Recognising a file that must be RENDERED rather than read.
 *
 * pi's read tool refuses a line larger than its byte limit and points at a
 * bash fallback:
 *
 *   [Line 388 is 459.2KB, exceeds 50.0KB limit. Use bash: sed -n '388p' <path> | head -c 51200]
 *
 * For source that advice is fine. For a self-extracting or bundled document it
 * is a dead end that reads like a way forward, and it cost a real session: the
 * reference mockup for a GUI build was a 662KB HTML bundle whose entire UI sat
 * on line 388. Every read returned the wrapper — `<title>Bundled Page</title>`,
 * a `#__bundler_loading` div, a black body — so the agent's only impression of
 * the design it had been told to copy was a loading screen, and it built its
 * own UI instead. Taking the first 51200 bytes of a 459KB minified blob would
 * not have helped either.
 *
 * The fix is to say so at the moment the refusal appears: this file is a
 * document, the bytes are packed, open it in a browser and look.
 */

/** pi's refusal, from core/tools/read.js. Captures the line and the path. */
// The limit is written "50.0KB", so the size itself contains a dot — an
// `[^.]+` run to the sentence's full stop cannot cross it and matched nothing.
// Anchored on the literal " Use bash: sed" instead, with a lazy run before it.
const OVERSIZED_LINE = /\[Line (\d+) is ([\d.]+\w+), exceeds .+?\. Use bash: sed -n '\d+p' (.+?) \| head -c \d+\]/;

export interface OversizedLine {
	line: number;
	size: string;
	path: string;
}

export function parseOversizedLine(text: string): OversizedLine | undefined {
	const match = OVERSIZED_LINE.exec(text);
	if (!match) return undefined;
	return { line: Number(match[1]), size: match[2]!, path: match[3]!.trim() };
}

/**
 * Documents whose meaning is what they LOOK like, not what their bytes say.
 *
 * Deliberately narrow. A giant line in a .js or .css file is minified source
 * and `sed` really is the right answer there; only formats that render to
 * something a person is meant to see get the extra advice.
 */
const RENDERABLE = /\.(html?|svg|pdf)$/i;

export function isRenderable(path: string): boolean {
	return RENDERABLE.test(path.trim());
}

/**
 * A file:// URL for a path, safe to paste inside single quotes in a shell.
 *
 * encodeURI is not enough on either count. It leaves `'` alone, and the command
 * below wraps the URL in single quotes — one apostrophe in a filename closed the
 * quote and the agent got a shell syntax error or a hung continuation prompt. It
 * also leaves `#` and `?`, which a browser reads as a fragment or query, so
 * "design #2.html" asked for "design " and screenshotted a blank page. Either
 * way the agent concluded the reference was unusable and invented its own UI —
 * precisely the failure this file exists to prevent.
 *
 * Each path SEGMENT is encoded, which is why the split is needed —
 * encodeURIComponent escapes the separator too. It handles `#` and `?`, but NOT
 * the apostrophe: `'` is one of the characters it deliberately leaves alone
 * (`!'()*`), so it has to be escaped by hand afterwards. Inside single quotes
 * that is the only character the shell treats specially, so escaping it makes
 * the whole URL quote-safe.
 */
export function fileUrl(path: string): string {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	return `file://${encoded.replace(/'/g, "%27")}`;
}

/**
 * The advice appended to pi's refusal. Concrete commands, because the failure
 * mode is an agent that knows it is stuck and picks the nearest plausible
 * substitute rather than the right tool.
 */
export function renderAdvice(found: OversizedLine): string {
	return [
		"",
		`This looks like a BUNDLED DOCUMENT: ${found.size} on a single line is packed or minified content, not something to read.`,
		"Slicing it with sed will give you a fragment of the packing, not the document — and if it self-extracts on load, the readable source shows only the loader, never the result.",
		"",
		"Render it and look at it instead:",
		`  agent-browser --session ref --allow-file-access open '${fileUrl(found.path)}'`,
		"  agent-browser --session ref wait 4000            # let any unpacker run",
		"  agent-browser --session ref set viewport 1440 900",
		"  agent-browser --session ref screenshot /tmp/ref.png   # then read that image",
		"  agent-browser --session ref eval 'document.body.innerHTML.length'  # and pull the UNPACKED DOM",
		"",
		"Read the screenshot as an image and extract the unpacked DOM for exact text, colours and layout. Do that before building anything that is supposed to match it.",
	].join("\n");
}

/**
 * Rewrite one read result. Returns undefined when there is nothing to add,
 * which is the common case and must not allocate a replacement.
 */
export function adviseOnReadResult(text: string): string | undefined {
	const found = parseOversizedLine(text);
	if (!found || !isRenderable(found.path)) return undefined;
	return text + renderAdvice(found);
}
