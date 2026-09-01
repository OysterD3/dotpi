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
import { Container, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";
import { dropBlank, trimBlank, withGutter } from "./render.ts";
import { summarise } from "./summary.ts";

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
	retireThinking();
	groupTools();
}

// ------------------------------------------------------------ collapsing runs

/**
 * A tool component pi has already decided to draw as nothing.
 *
 * Neither folded nor counted, and — the point — it does not break a run either.
 * Treating it as a run-breaker would split one summary into two around
 * something invisible, and counting it would announce a call that was never on
 * screen.
 */
function invisible(child: Component): boolean {
	if (child instanceof ToolExecutionComponent) return (child as unknown as ToolInternals).hideComponent;
	return silentAssistant(child);
}

/**
 * An assistant message that says nothing the reader can see.
 *
 * A turn that calls tools is a chain of assistant messages — reason, call,
 * reason, call — and the ones in the middle carry only reasoning and the calls
 * themselves. Once the reasoning is retired they render as nothing at all, and
 * a nothing sitting between two calls was splitting one run into two: on screen,
 * two summary lines with an invisible gap between them where a single line
 * belonged.
 *
 * Text is the boundary. The moment the model actually says something, the calls
 * before it and the calls after it are answering different things and belong in
 * different groups. The live component is never silent — its reasoning is still
 * showing, which is a thing on screen.
 */
function silentAssistant(child: Component): boolean {
	if (!(child instanceof AssistantMessageComponent)) return false;
	if (child === liveMessage) return false;
	const message = (child as unknown as { lastMessage?: { content?: unknown } }).lastMessage;
	const content = message?.content;
	if (!Array.isArray(content)) return false;
	return !content.some((block) => {
		const part = block as { type?: unknown; text?: unknown };
		return part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0;
	});
}

/**
 * A settled tool call this is allowed to fold into a summary.
 *
 * Four exclusions, each load-bearing:
 *
 *   - **still running.** A call with no result yet, or a partial one, is the
 *     thing you are watching. Folding it away would hide the only moving part
 *     on the screen, and the run it belongs to is not finished being written.
 *   - **expanded.** This is how "expand" works: pi's own `app.tools.expand`
 *     sets `expanded` on every tool component, so the group simply stops
 *     grouping. No second keybinding, and no state of this extension's own to
 *     get out of step with pi's.
 *   - **a custom render shell.** An extension chose how that tool looks — the
 *     workflow panel relies on it — which is the same exclusion unboxTools
 *     makes, and for the same reason. Note that merely HAVING a renderer
 *     definition is not it: every built-in tool has one.
 *   - **images.** A screenshot is the content, not a detail of it, and a line
 *     saying one was taken is not the same information.
 */
function foldable(child: Component): boolean {
	if (!(child instanceof ToolExecutionComponent)) return false;
	const self = child as unknown as ToolInternals & { isPartial: boolean; toolName: string };
	if (self.hideComponent) return false;
	if (self.expanded) return false;
	if (self.result === undefined || self.isPartial) return false;
	if (self.imageComponents.length > 0) return false;
	try {
		if (self.hasRendererDefinition() && self.getRenderShell() !== "default") return false;
	} catch {
		return false;
	}
	return true;
}

/**
 * The maximal run starting at `from`: how many children it spans, and how many
 * of those are calls worth naming. The two differ by the invisible ones, which
 * the run steps over.
 */
function runFrom(children: readonly Component[], from: number): { span: number; folded: Component[] } {
	const folded: Component[] = [];
	let end = from;
	for (; end < children.length; end++) {
		const child = children[end]!;
		if (invisible(child)) continue;
		if (!foldable(child)) break;
		folded.push(child);
	}
	// Trailing invisibles belong to whatever comes next, not to this run.
	while (end > from && invisible(children[end - 1]!)) end--;
	return { span: end - from, folded };
}

/**
 * Replace runs of settled tool calls with one line saying what they did.
 *
 * Patched on Container rather than on the tool component because the decision
 * needs siblings: whether a call is the third of five or on its own is not
 * something the call can see, and pi hands every tool component to the same
 * `chatContainer.addChild`, so the container is the one object that knows the
 * order. Every other container in the tree holds text and markdown, so the
 * `some(foldable)` test below is both the guard against touching them and the
 * fast path out.
 */
function groupTools(): void {
	const original = Container.prototype.render;
	Container.prototype.render = function patched(this: Container, width: number): string[] {
		try {
			const children = this.children;
			if (children.length < CONFIG.collapseFrom || !children.some(foldable)) return original.call(this, width);

			const lines: string[] = [];
			for (let i = 0; i < children.length; i++) {
				const run = runFrom(children, i);
				if (run.folded.length >= CONFIG.collapseFrom) {
					lines.push("", summaryLine(run.folded, width));
					i += run.span - 1;
					continue;
				}
				for (const line of children[i]!.render(width)) lines.push(line);
			}
			return lines;
		} catch {
			return original.call(this, width);
		}
	};
}

/** "● Searched for 1 pattern, read 2 files, ran 2 shell commands", clamped to width. */
function summaryLine(run: readonly Component[], width: number): string {
	const names = run.map((child) => (child as unknown as { toolName: string }).toolName);
	const mark = paint(CONFIG.summaryColor, CONFIG.callMark);
	const text = paint(CONFIG.summaryColor, summarise(names));
	// Truncated, not wrapped: the point of the line is that a run of calls costs
	// exactly one row, and a wrapped summary of a 40-call run would cost three.
	return truncateToWidth(`${mark}${text}`, width, "…");
}

// ------------------------------------------------------- reasoning, once done

/**
 * The component pi is currently streaming into, or undefined between turns.
 *
 * pi builds one AssistantMessageComponent per assistant message and calls
 * updateContent on it repeatedly as tokens arrive, so "the live one" is
 * whichever was updated last while a turn is running. Identifying the COMPONENT
 * rather than the turn is what keeps the scrollback still: a flag that only said
 * "a turn is running" would un-hide the reasoning of every historical message
 * for the length of every new turn and hide it again at the end.
 */
let liveMessage: object | undefined;
let turnRunning = false;

/**
 * Every component that was live at some point in this turn.
 *
 * A turn is not one assistant message. One that calls tools is a chain of them
 * — reason, call, reason, call — and each gets its own component, each reasons,
 * and each stops being live the moment the next one starts. Rebuilding only
 * whichever happened to be last left a "Thinking..." on every message before
 * it, which is most of a long turn: the first version of this cleared exactly
 * one label per turn and looked, in a short exchange, as though it worked.
 */
const touched = new Set<object>();

/** Called from index.ts on the first agent_start of a run. */
export function beginTurn(): void {
	turnRunning = true;
}

/**
 * Called on agent_settled: drop the exemption, then REBUILD the message that
 * had it.
 *
 * Clearing the flag alone is not enough, and the reason is the shape of the
 * component. `updateContent` is what turns a message into child components, and
 * it only runs while tokens are arriving — a later `render()` just draws the
 * children it already built. So the turn that has this moment just finished
 * would keep its reasoning on screen until something happened to rebuild it,
 * which in practice means until the session was reloaded.
 *
 * Re-running it against pi's own stored `lastMessage` costs one rebuild per
 * turn and dirties the component, so pi's end-of-turn render picks the change
 * up without anyone asking for a repaint.
 */
export function endTurn(): void {
	turnRunning = false;
	// Cleared FIRST, so the calls below take the stripping path rather than the
	// exemption they are being called to end.
	liveMessage = undefined;
	for (const component of touched) {
		const self = component as { lastMessage?: unknown; updateContent?(message: unknown): void };
		if (!self.updateContent || self.lastMessage === undefined) continue;
		try {
			self.updateContent(self.lastMessage);
		} catch {
			/* that message keeps its reasoning; nothing else is disturbed */
		}
	}
	touched.clear();
}

/** Test seam: the patches install once per process and cannot be undone. */
export function thinkingState(): { turnRunning: boolean; live: boolean; touched: number } {
	return { turnRunning, live: liveMessage !== undefined, touched: touched.size };
}

/**
 * Reasoning is worth reading while it happens and is noise once the answer is
 * there.
 *
 * With `hideThinkingBlock` on, pi leaves one italic "Thinking..." label per run
 * of reasoning, forever — a line per assistant message, saying only that
 * something was thought. With it off, the whole reasoning text stays. Both are
 * the same complaint at different volumes, and both are answered here: the live
 * message renders whatever pi would render, and every settled one renders as
 * though it never reasoned.
 *
 * Done by handing pi a message with the thinking blocks FILTERED OUT rather
 * than by editing the lines that come back. pi already handles a message with
 * no reasoning in it — `thinkingBlocks.length === 0` skips the label and the
 * spacing decision that follows it — so stripping the input reuses that path
 * instead of second-guessing it, and it behaves the same whichever way
 * hideThinkingBlock is set.
 */
function retireThinking(): void {
	const cls = AssistantMessageComponent as unknown as {
		prototype: { updateContent(message: unknown): void };
	};
	const original = cls.prototype.updateContent;
	cls.prototype.updateContent = function patched(this: object, message: unknown): void {
		try {
			// Streaming marks this component live; the exemption is released at
			// agent_settled, not here, so the last frame of a turn still shows it.
			// Every one of them is remembered, because every one of them will need
			// rebuilding — see `touched`.
			if (turnRunning) {
				liveMessage = this;
				touched.add(this);
			}
			if (this === liveMessage) return original.call(this, message);
			return original.call(this, withoutThinking(message));
		} catch {
			return original.call(this, message);
		}
	};
}

/**
 * A copy of the message with reasoning removed, or the message itself when
 * there was none — so the overwhelmingly common case allocates nothing and a
 * shape this does not recognise is passed through untouched.
 */
export function withoutThinking<T>(message: T): T {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return message;
	const kept = content.filter((block) => (block as { type?: unknown })?.type !== "thinking");
	if (kept.length === content.length) return message;
	return { ...(message as object), content: kept } as T;
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
			//
			// The dot colour is in the key too, and has to be: pi's `write` tool
			// renders NO result lines on success, so finishing changes the dot
			// and nothing else. Keyed on the lines alone, every successful write
			// stayed grey for the rest of the session — and since the box went,
			// the dot is the only thing left saying how a call turned out.
			const dot = dotColor(self);
			const key = [dot, String(callRaw.length), ...callRaw, ...resultRaw];
			const memo = memos.get(this as object);
			if (unchanged(memo, width, key)) return memo.output;

			const callLines = trimBlank(callRaw);
			const resultLines = self.expanded ? trimBlank(resultRaw) : dropBlank(resultRaw);
			const output =
				callLines.length === 0 && resultLines.length === 0
					? []
					: [
							"",
							...withGutter(callLines, paint(dot, CONFIG.callMark)),
							...withGutter(resultLines, paint(CONFIG.resultColor, CONFIG.resultMark)),
						];
			memos.set(this as object, { width, paint: paintGeneration, input: key, output });
			return output;
		} catch {
			return original.call(this, width);
		}
	};
}
