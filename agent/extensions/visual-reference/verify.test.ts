/**
 * Tests for verify.ts: the dirty-tracking state machine and its path/command
 * matchers, kept separate from visual-reference.test.ts because this is new,
 * independently-toggleable behaviour (visualReference.verifyGate) with no
 * relation to the read-refusal advice or the guideline text.
 *
 * Run: jiti agent/extensions/visual-reference/verify.test.ts
 */
import {
	followUpMessage,
	isDirtyUiPath,
	isRenderEvidenceCommand,
	referencesRenderableFileUrl,
	resultReturnsImage,
	VerifyGate,
	wasUserAborted,
} from "./verify.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

console.log("--- which edits count as dirty ---");
check("css", isDirtyUiPath("/app/src/Button.css"), true);
check("scss", isDirtyUiPath("/app/src/Button.scss"), true);
check("less", isDirtyUiPath("/app/src/Button.less"), true);
check("tsx", isDirtyUiPath("/app/src/Button.tsx"), true);
check("jsx", isDirtyUiPath("/app/src/Button.jsx"), true);
check("html", isDirtyUiPath("/app/index.html"), true);
check("vue", isDirtyUiPath("/app/src/Button.vue"), true);
check("svelte", isDirtyUiPath("/app/src/Button.svelte"), true);
check("case-insensitive", isDirtyUiPath("/app/src/Button.CSS"), true);
// A plain .ts store or hook is invisible until something re-renders it — the
// benchmark's 12 edits were CSS/TSX, not TS, and flagging every file that
// COULD affect a render would fire on nearly the whole frontend.
check("plain .ts is not dirty", isDirtyUiPath("/app/src/store.ts"), false);
check("unrelated extension", isDirtyUiPath("/app/README.md"), false);
check("no extension", isDirtyUiPath("/app/Makefile"), false);

console.log("\n--- which bash commands count as render evidence ---");
check("agent-browser screenshot", isRenderEvidenceCommand("agent-browser --session app screenshot /tmp/out.png"), true);
check("screencapture", isRenderEvidenceCommand("screencapture -x /tmp/x.png"), true);
check("playwright", isRenderEvidenceCommand("npx playwright test e2e/home.spec.ts"), true);
check("puppeteer", isRenderEvidenceCommand("node puppeteer-shot.js"), true);
check("bare 'screenshot' word", isRenderEvidenceCommand("take a screenshot please"), true);
check("case-insensitive", isRenderEvidenceCommand("AGENT-BROWSER screenshot"), true);
check("an ordinary build command is not evidence", isRenderEvidenceCommand("npm run build"), false);
check("an ordinary test run is not evidence", isRenderEvidenceCommand("npm test"), false);

console.log("\n--- which bash commands reference a renderable reference document ---");
check(
	"an agent-browser open of a file:// html mockup",
	referencesRenderableFileUrl("agent-browser --session ref --allow-file-access open 'file:///tmp/ref/mock.html'"),
	true,
);
check("a plain file:// html url", referencesRenderableFileUrl("cat file:///tmp/ref/mock.html"), true);
// Query and fragment must be stripped before the extension is checked, or a
// query string containing ".png" (say) would poison the extension test.
check(
	"query and fragment are stripped before matching",
	referencesRenderableFileUrl("open 'file:///tmp/ref/mock.html?x=1#section'"),
	true,
);
// The URL is a CSS file, not a document — not the reference-document signal.
check("a file:// url to css is not a reference document", referencesRenderableFileUrl("cat file:///tmp/ref/site.css"), false);
check("no file:// url at all", referencesRenderableFileUrl("agent-browser screenshot /tmp/out.png"), false);
check("an http url is not a file:// reference", referencesRenderableFileUrl("curl https://example.com/mock.html"), false);
// A malformed %-escape must not sink the whole check — the raw (still-encoded)
// path is tried instead, and its extension is untouched by the bad escape.
check(
	"a malformed percent-escape falls back instead of throwing",
	referencesRenderableFileUrl("open 'file:///tmp/ref/bad%zzname.html'"),
	true,
);

console.log("\n--- which tool results are render evidence via an image ---");
check("a read result with an image block", resultReturnsImage([{ type: "image" }]), true);
check("a read result that is text only", resultReturnsImage([{ type: "text" }]), false);
check("an empty content array", resultReturnsImage([]), false);
check("mixed content with an image among text", resultReturnsImage([{ type: "text" }, { type: "image" }]), true);

console.log("\n--- which agent_end message arrays are a user abort ---");
/** Stands in for AgentMessage; the fixtures below only fill the fields wasUserAborted reads. */
type Msg = any;
const assistantMsg = (stopReason: string): Msg => ({ role: "assistant", stopReason });
const toolResultMsg: Msg = { role: "toolResult" };
const userMsg: Msg = { role: "user" };

check("no messages at all is not an abort", wasUserAborted([]), false);
check("no assistant message anywhere is not an abort", wasUserAborted([userMsg, toolResultMsg]), false);
check("a plain natural stop is not an abort", wasUserAborted([userMsg, assistantMsg("stop")]), false);
// Narrow on purpose: a provider error is not the user pressing Escape, and
// conflating the two would suppress the follow-up on a failure it has
// nothing to do with.
check("a provider error is not conflated with an abort", wasUserAborted([userMsg, assistantMsg("error")]), false);
// The realistic case scanning exists for: the run's last assistant message
// stopped for more tool calls (stopReason "toolUse"), then the loop ended
// anyway after running them — the array's last entry is a tool result, not
// the assistant message that actually set the reason.
check(
	"a natural stop whose last message is a tool result is still read correctly",
	wasUserAborted([userMsg, assistantMsg("toolUse"), toolResultMsg]),
	false,
);
check("the user pressing Escape is an abort", wasUserAborted([userMsg, assistantMsg("aborted")]), true);
check(
	"an abort after an earlier tool-using turn is still found by scanning from the end",
	wasUserAborted([userMsg, assistantMsg("toolUse"), toolResultMsg, userMsg, assistantMsg("aborted")]),
	true,
);

console.log("\n--- the follow-up wording ---");
const message = followUpMessage(3, ["a.css", "b.tsx", "c.html"]);
check("it states the observed count", message.includes("You changed 3 UI files since the last render"), true);
check("it names the files", message.includes("(a.css, b.tsx, c.html)"), true);
check("it asks for both sides at the same viewport", message.includes("Rebuild, screenshot your app AND the reference at the same viewport"), true);
check("it asks to name the differences before stopping", message.includes("name the differences before stopping"), true);
// The whole point of this half of the extension: a rendered edit is verified,
// an unrendered one is not — softer language ("consider checking") is exactly
// the advice the static guideline already tried.
check("it states the thesis plainly", message.includes("unrendered UI edits are unverified edits"), true);
// The list must not grow without bound on a long session.
const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.css`);
check("the file list is capped even if more are passed in", followUpMessage(20, manyFiles).includes("file7.css"), true);
check("beyond the cap is not listed", followUpMessage(20, manyFiles).includes("file8.css"), false);

console.log("\n--- the dirty-tracking state machine ---");
{
	const gate = new VerifyGate();
	check("starts clean", gate.hasDirt(), false);
	check("nothing to say when clean", gate.takeFollowUp(), undefined);
}
{
	const gate = new VerifyGate();
	gate.recordDirtyEdit("/app/Button.css");
	check("one edit makes it dirty", gate.hasDirt(), true);
	const message = gate.takeFollowUp();
	check("reports the one file", message?.includes("You changed 1 UI files since the last render (/app/Button.css)"), true);
}
{
	// The benchmark's failure mode, in miniature: several edits to a few files.
	const gate = new VerifyGate();
	gate.recordDirtyEdit("/app/Button.css");
	gate.recordDirtyEdit("/app/Button.css");
	gate.recordDirtyEdit("/app/Header.tsx");
	const message = gate.takeFollowUp();
	// The COUNT is edits (3), not distinct files (2) — matching how the
	// benchmark's "12 CSS/TSX edits" was itself an edit count.
	check("count is edits, not distinct files", message?.includes("You changed 3 UI files"), true);
	check("the file list is deduplicated", message?.includes("(/app/Button.css, /app/Header.tsx)"), true);
}
{
	// Render evidence clears outstanding dirt, whichever form it takes.
	const gate = new VerifyGate();
	gate.recordDirtyEdit("/app/Button.css");
	gate.clearDirty();
	check("a render clears the dirty count", gate.hasDirt(), false);
	check("nothing to say right after a render", gate.takeFollowUp(), undefined);
}
{
	// Firing the follow-up does NOT itself count as a render: the agent has to
	// actually rebuild and screenshot, not just receive the nudge.
	const gate = new VerifyGate();
	gate.recordDirtyEdit("/app/Button.css");
	gate.recordDirtyEdit("/app/Header.tsx");
	const first = gate.takeFollowUp();
	check("first firing reports 2", first?.includes("You changed 2 UI files"), true);
	const second = gate.takeFollowUp();
	check("still dirty after firing once — the count did not reset itself", second?.includes("You changed 2 UI files"), true);
}
{
	// The firing cap: two nudges per session, then silence — a model that
	// ignored two evidence-bearing instructions is not going to be reached by a
	// third, and unbounded nagging spends money on a lost cause.
	const gate = new VerifyGate();
	gate.recordDirtyEdit("/app/Button.css");
	check("first firing", gate.takeFollowUp() !== undefined, true);
	check("second firing", gate.takeFollowUp() !== undefined, true);
	check("third firing is suppressed by the cap", gate.takeFollowUp(), undefined);
	// More edits after the cap is spent still shouldn't produce a follow-up —
	// the cap is a hard stop, not a threshold that resets on new dirt.
	gate.recordDirtyEdit("/app/More.css");
	check("still suppressed after more edits", gate.takeFollowUp(), undefined);
}
{
	// The file list itself is capped, not just its display — bounding memory on
	// a session that touches dozens of files.
	const gate = new VerifyGate();
	for (let i = 0; i < 20; i++) gate.recordDirtyEdit(`/app/file${i}.css`);
	const message = gate.takeFollowUp();
	check("count reports every edit", message?.includes("You changed 20 UI files"), true);
	check("the file sample stops at the cap", message?.includes("file7.css)"), true);
	check("later files are not in the sample", message?.includes("file10.css"), false);
}

console.log("\n--- the reference-screenshot pin (armed by a file:// open, consumed by the next image) ---");
{
	const gate = new VerifyGate();
	check("nothing to consume before anything is armed", gate.consumePin("call-1"), undefined);
}
{
	const gate = new VerifyGate();
	gate.armPin();
	check("armed, the next image read is pinned", gate.consumePin("call-1"), "call-1");
	check("consuming disarms it — one-shot", gate.consumePin("call-2"), undefined);
}
{
	// Arming twice in a row (e.g. re-opening the same reference) must not queue
	// two pins for one image read.
	const gate = new VerifyGate();
	gate.armPin();
	gate.armPin();
	check("re-arming is idempotent", gate.consumePin("call-1"), "call-1");
	check("still one-shot after a double arm", gate.consumePin("call-2"), undefined);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
