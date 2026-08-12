/**
 * The patches themselves: three `render` methods, replaced in place.
 *
 * pi has no hook for redrawing its own transcript. `registerMessageRenderer`
 * and `registerEntryRenderer` are both keyed by a *custom* type, so they draw
 * entries an extension invented and nothing pi produces itself. What pi does
 * export publicly is the component classes, and its extension loader aliases
 * `@earendil-works/pi-coding-agent` to the very `dist/index.js` the running
 * TUI was built from — so the class an extension imports is the same object
 * `interactive-mode.js` constructs from. Replacing a method on its prototype
 * is therefore the whole mechanism, and `instanceof` keeps working, which
 * interactive-mode relies on when it walks its children.
 *
 * Every patch narrows the render width by the width of the mark it is about to
 * add, so a line comes back exactly as wide as it went in and pi's wrapping is
 * left to do its own job.
 *
 * Every patch also falls back to the original on any throw. These are internal
 * shapes with no compatibility promise; a pi upgrade that moves them should
 * cost the marks, not the session.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";
import { dropBlank, trimBlank, withGutter } from "./render.ts";

type Render = (width: number) => string[];

/**
 * The private members of ToolExecutionComponent this reads. Private in
 * TypeScript is not private at runtime; naming them here keeps the reach into
 * pi's internals in one visible place rather than spread over casts.
 */
interface ToolInternals {
	hideComponent: boolean;
	contentBox: { children: Component[] };
	imageComponents: Component[];
	result?: { isError: boolean };
	expanded: boolean;
	hasRendererDefinition(): boolean;
	getRenderShell(): string;
}

/**
 * The dot is now the only thing that says how a call turned out — the tint it
 * replaced said it with a whole box of colour.
 */
function dotColor(self: ToolInternals): string {
	if (self.result === undefined) return CONFIG.callPendingColor;
	return self.result.isError ? CONFIG.callErrorColor : CONFIG.callOkColor;
}

/**
 * Per-component memo of the last gutter transform.
 *
 * pi re-renders the whole transcript every frame — `Container.render` walks its
 * children unconditionally — and it gets away with that because every leaf
 * caches its own lines and hands back the same strings. The gutter work sat
 * outside that: a regex strip and a width measure per line per frame, which at
 * a thousand turns cost 100ms a frame against pi's 1.6ms, and read as exactly
 * the lag it was.
 *
 * So the transform is cached against the lines it was computed from. The check
 * is a pointer compare per line, not a content compare, precisely because the
 * leaves return their cached strings — an unchanged block is identical by
 * identity, and only the streaming tail misses. Keyed on the component with a
 * WeakMap so a rewound or replaced component takes its memo with it.
 *
 * Deliberately not hooked to `invalidate()`, which would be the idiomatic
 * route: `updateContent` can change a message without one, and a stale gutter
 * is a wrong frame. Comparing the input validates itself.
 */
interface Memo {
	width: number;
	/**
	 * Which paint function drew the mark. The marks are the one part of the
	 * output that does NOT come from the input lines, so a `/theme` switch can
	 * repaint everything a component renders and still leave a memo that looks
	 * current. Counted rather than compared, since the function identity is the
	 * only thing that changes.
	 */
	paint: number;
	input: readonly string[];
	output: string[];
}

const memos = new WeakMap<object, Memo>();

function unchanged(memo: Memo | undefined, width: number, lines: readonly string[]): memo is Memo {
	if (memo === undefined || memo.width !== width || memo.paint !== paintGeneration) return false;
	if (memo.input.length !== lines.length) return false;
	for (let i = 0; i < lines.length; i += 1) {
		if (memo.input[i] !== lines[i]) return false;
	}
	return true;
}

/** Painted by the live theme once it loads; plain until then. */
type Paint = (color: string, text: string) => string;
let paint: Paint = (_color, text) => text;
/** Bumped whenever the marks would be drawn differently — see Memo.paint. */
let paintGeneration = 0;

export function setPaint(next: Paint): void {
	paint = next;
	paintGeneration += 1;
}

/**
 * Guards against wrapping the wrappers. Kept on `globalThis` rather than in a
 * module variable because pi's loader builds a fresh jiti with `moduleCache:
 * false` for every load, so a `/reload` re-evaluates this file while the
 * classes it already patched live on.
 */
const APPLIED = Symbol.for("pi.transcript.applied");

/**
 * Replaces the three render methods. Safe to call more than once: the second
 * call returns without doing anything, because wrapping an already-wrapped
 * render would add a second mark and narrow the width twice.
 */
export function applyPatches(): void {
	const flags = globalThis as Record<symbol, unknown>;
	if (flags[APPLIED] === true) return;
	flags[APPLIED] = true;

	markBlock(AssistantMessageComponent, CONFIG.assistantMark, CONFIG.assistantColor);
	markBlock(UserMessageComponent, CONFIG.userMark, CONFIG.userColor);
	unboxTools();
}

/**
 * Gives a whole message one mark and a hanging indent. The component keeps
 * drawing its own content — this only reserves a column and fills it.
 */
function markBlock(cls: { prototype: { render: Render } }, mark: string, color: string): void {
	const original = cls.prototype.render;
	cls.prototype.render = function patched(this: unknown, width: number): string[] {
		try {
			const lines = original.call(this, width - visibleWidth(mark));
			if (lines.length === 0) return lines;
			const memo = memos.get(this as object);
			if (unchanged(memo, width, lines)) return memo.output;
			const output = withGutter(lines, paint(color, mark));
			memos.set(this as object, { width, paint: paintGeneration, input: lines, output });
			return output;
		} catch {
			return original.call(this, width);
		}
	};
}

/**
 * Strips a tool call's tinted box and re-frames it as a call and its result.
 *
 * pi draws a tool call as a full-width `Box` in a success/error/pending tint,
 * holding two children: whatever `renderCall` drew, then whatever
 * `renderResult` drew. The box is not restyled, it is stepped around — the two
 * children are rendered directly, which drops the tint and the box's own
 * vertical padding in one move and leaves the tool's real content (a diff,
 * highlighted source, command output) exactly as its renderer drew it.
 *
 * The two children are marked separately rather than as one block, because
 * they are two things: the call opens at column 0 under a dot coloured by its
 * outcome, and the result hangs under a corner at column 2. Rendering them
 * apart is also what removes the blank line pi puts between them — each is
 * trimmed at its own edges, so a blank line that is really *in* a command's
 * output survives while the seam between call and result does not.
 *
 * What is left alone is a tool that already draws its own frame —
 * `renderShell: "self"`, which pi renders outside the box entirely. That is
 * the only flag meaning "this author chose the framing", so it is the only
 * thing worth deferring to.
 *
 * It is deliberately *not* enough that a tool came from an extension. The
 * first cut bailed on any `toolDefinition.renderCall`, which quietly excluded
 * almost every call in a real session: `background-shell` replaces `bash`, and
 * its renderer delegates straight back to pi's built-in donor for every
 * foreground command. Its output is the built-in's output, so boxing it while
 * de-boxing everything else was inconsistent, not respectful.
 *
 * Two cases still keep the original renderer:
 *   - a tool with no renderer at all, whose fallback text carries the tint on
 *     the text component rather than on a box;
 *   - a result with images, which the original render composes with spacers
 *     below the box.
 */
function unboxTools(): void {
	const original = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function patched(this: unknown, width: number): string[] {
		const self = this as unknown as ToolInternals;
		try {
			if (self.hideComponent) return [];
			if (!self.hasRendererDefinition() || self.getRenderShell() !== "default") return original.call(this, width);
			if (self.imageComponents.length > 0) return original.call(this, width);

			const [call, ...rest] = self.contentBox.children;
			// The children are pi's own cached components, so rendering them is
			// cheap; what has to be kept off the hot path is the framing below.
			const callRaw = call === undefined ? [] : call.render(width - visibleWidth(CONFIG.callMark));
			const resultRaw = rest.flatMap((child) => child.render(width - visibleWidth(CONFIG.resultMark)));

			// One memo per component, so the split has to survive the compare —
			// the marker keeps a call line from being mistaken for a result line
			// of the same text.
			const key = [String(callRaw.length), ...callRaw, ...resultRaw];
			const memo = memos.get(this as object);
			if (unchanged(memo, width, key)) return memo.output;

			const callLines = trimBlank(callRaw);
			const resultLines = self.expanded ? trimBlank(resultRaw) : dropBlank(resultRaw);
			const output =
				callLines.length === 0 && resultLines.length === 0
					? []
					: [
							"",
							...withGutter(callLines, paint(dotColor(self), CONFIG.callMark)),
							...withGutter(resultLines, paint(CONFIG.resultColor, CONFIG.resultMark)),
						];
			memos.set(this as object, { width, paint: paintGeneration, input: key, output });
			return output;
		} catch {
			return original.call(this, width);
		}
	};
}
