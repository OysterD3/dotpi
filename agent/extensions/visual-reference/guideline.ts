/**
 * The standing guideline: when the task names something to match, look at it
 * before building.
 *
 * Written from a measured failure. Given "implement this GUI, use the UI mockup
 * <file>", the session opened its OWN app in a browser 23 times and the
 * reference 6 times, and did not render the reference until 12 tool calls AFTER
 * it had started writing UI code. The comparison run opened the mockup as its
 * first two browser pages, before it ever opened localhost.
 *
 * Neither capability nor technique was missing: the browser CLI was installed,
 * the session model accepts images, and the agent eventually did it perfectly
 * — open, wait for the unpacker, set a viewport, screenshot, extract the DOM.
 * It simply did that sixth instead of first, by which point it had already
 * committed to a design of its own and was verifying that against itself.
 *
 * Hence a rule about ORDER rather than ability, and one that names the specific
 * trap: verifying your own output looks like progress, and is not the same as
 * comparing it to the thing you were asked to match.
 */

export const VISUAL_REFERENCE_GUIDELINE = [
	"## Working from a reference",
	"",
	"When the task points at something your output is meant to match — a mockup, a screenshot, a design file, a page to reproduce — look at the reference BEFORE you build, not after.",
	"",
	"- Render it, don't read it. A mockup's meaning is what it looks like. Reading its markup gives you a loader, a wrapper, or minified noise; open it in a browser, wait for it to settle, screenshot it, and read the screenshot as an image.",
	"- Pull the exact values too. A screenshot gives you layout and feel; the rendered DOM gives you the real text, colours, spacing and structure. Take both — guessing a hex code from an image wastes a round trip.",
	"- Then build. Committing to your own design first and consulting the reference afterwards produces something that looks like your idea with the reference's colours, and every later comparison is anchored to the wrong starting point.",
	"- Looking at your own output is not comparison. Screenshotting the thing you just built tells you it renders, not that it matches. Put the reference and your version side by side, at the same viewport, and name the differences.",
	"- If the reference cannot be rendered or does not match what you were told to expect, say so and ask. Building from a reference you could not actually see is the one outcome worth stopping for.",
].join("\n");
