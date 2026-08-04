/**
 * The diet itself: what to drop, and what the model reads in its place. Pure —
 * every function here takes messages and settings and returns a decision, so
 * the rules can be tested without a session.
 *
 * Two invariants hold the whole thing up, and both are load-bearing enough that
 * the tests assert them directly:
 *
 *   1. A dropped result is replaced, never removed. Every tool call must keep a
 *      matching result or the provider rejects the request outright — so the
 *      message stays in place, at the same index, with the same toolCallId, and
 *      only its content changes.
 *
 *   2. A stub renders byte-identically every time. Evictions are sticky and the
 *      stub is built from facts fixed at eviction time (label, size), never from
 *      anything that moves. A stub that drifted by one character would relocate
 *      the prompt cache's first mismatch on every single call, and re-reading a
 *      250k context uncached costs ten times what reading it cached does. This
 *      extension would then be, precisely, an expensive way to lose information.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { CONFIG, type DietSettings } from "./config.ts";

/** What a stub needs to describe what used to be there. Fixed at eviction time. */
export interface EvictionRecord {
	toolCallId: string;
	/** "read src/App.tsx", "bash pnpm test", or bare "grep" when args say nothing. */
	label: string;
	/** Size of the original content, for the stub. */
	bytes: number;
	/** What dropping it saves, net of the stub. Planning only. */
	savedTokens: number;
	/** True when a later read of the same file made this one redundant. Changes the stub's wording. */
	superseded?: boolean;
}

export interface DietPlan {
	records: EvictionRecord[];
	fromTokens: number;
	/** Projected size once the plan is applied. The provider's next response corrects it. */
	toTokens: number;
}

/** What a round leaves in the transcript. Custom entry, so the model never sees it. */
export interface DietEntry {
	dropped: number;
	fromTokens: number;
	toTokens: number;
	/** Assistant messages whose reasoning was stripped this round. Absent before the flag existed. */
	reasoningDropped?: number;
}

type ResultContent = (TextContent | ImageContent)[];

function isToolResult(message: AgentMessage): message is ToolResultMessage {
	return (message as { role?: string }).role === "toolResult";
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
	return (message as { role?: string }).role === "assistant";
}

export function contentBytes(content: ResultContent): number {
	let bytes = 0;
	for (const block of content) {
		if (block.type === "text") bytes += block.text.length;
		else if (block.type === "image") bytes += block.data.length;
	}
	return bytes;
}

export function contentTokens(content: ResultContent): number {
	let tokens = 0;
	for (const block of content) {
		if (block.type === "text") tokens += Math.ceil(block.text.length / CONFIG.charsPerToken);
		else if (block.type === "image") tokens += CONFIG.imageTokens;
	}
	return tokens;
}

function hasImage(content: ResultContent): boolean {
	return content.some((block) => block.type === "image");
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * A human-readable name for a tool call, so a stub says "read src/App.tsx"
 * rather than "a result". Without it the model cannot tell which of forty
 * dropped results it wants back, and re-runs the wrong one.
 */
export function describeCall(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = (key: string): string | undefined => (typeof a[key] === "string" ? (a[key] as string) : undefined);
	const detail =
		pick("file_path") ?? pick("path") ?? pick("command") ?? pick("pattern") ?? pick("query") ?? pick("prompt") ?? undefined;
	return detail ? `${name} ${clip(detail, CONFIG.labelChars)}` : name;
}

/** toolCallId → label, read off the assistant messages that made the calls. */
export function indexCallLabels(messages: readonly AgentMessage[]): Map<string, string> {
	const labels = new Map<string, string>();
	for (const message of messages) {
		if (!isAssistant(message)) continue;
		for (const block of message.content) {
			if (block.type === "toolCall") labels.set(block.id, describeCall(block.name, block.arguments));
		}
	}
	return labels;
}

interface ReadSpan {
	path: string;
	offset: number | null;
	limit: number | null;
}

/** toolCallId → what a read call asked for, off the same assistant messages. */
export function indexReadSpans(messages: readonly AgentMessage[]): Map<string, ReadSpan> {
	const spans = new Map<string, ReadSpan>();
	for (const message of messages) {
		if (!isAssistant(message)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "read") continue;
			const a = (block.arguments ?? {}) as Record<string, unknown>;
			if (typeof a.path !== "string" || a.path === "") continue;
			spans.set(block.id, {
				path: a.path,
				offset: typeof a.offset === "number" ? a.offset : null,
				limit: typeof a.limit === "number" ? a.limit : null,
			});
		}
	}
	return spans;
}

/**
 * Which read results a later read of the same file makes redundant.
 *
 * A session that edits a file re-reads it — the measured one read three of its
 * own source files three times each — and every older copy is pure waste. Worse
 * than waste: it is a *stale* copy of a file the model has since changed, kept
 * verbatim in context. So superseded reads lose the recency protection in
 * collectCandidates and are always swept by a round, even when the target is
 * already met — see planDiet.
 *
 * "Makes redundant" is deliberately narrow: a later whole-file read covers any
 * earlier read of that path, and a later identical (path, offset, limit) covers
 * its exact duplicate. A later *partial* read does not cover an earlier whole
 * read — the model may still be using the rest of the file — so that direction
 * is left alone.
 */
export function findSupersededReads(messages: readonly AgentMessage[], spans: ReadonlyMap<string, ReadSpan>): Set<string> {
	const ordered: { id: string; span: ReadSpan }[] = [];
	for (const message of messages) {
		if (!isToolResult(message) || message.isError) continue;
		const span = spans.get(message.toolCallId);
		if (span) ordered.push({ id: message.toolCallId, span });
	}

	// Walk newest → oldest: a read is superseded if a strictly later one covers it.
	const superseded = new Set<string>();
	const wholeSeen = new Set<string>();
	const exactSeen = new Set<string>();
	for (let i = ordered.length - 1; i >= 0; i--) {
		const { id, span } = ordered[i];
		const whole = span.offset === null && span.limit === null;
		const exact = `${span.path}\u0000${span.offset}\u0000${span.limit}`;
		if (wholeSeen.has(span.path) || exactSeen.has(exact)) superseded.add(id);
		if (whole) wholeSeen.add(span.path);
		exactSeen.add(exact);
	}
	return superseded;
}

export function stubText(record: EvictionRecord): string {
	// Superseded reads get told why: "this was a stale copy, the fresh one is
	// below" steers the model toward the newer read instead of a pointless re-run.
	if (record.superseded) {
		return `[stale copy dropped — ${record.label}, ${formatBytes(record.bytes)}. A newer read of this file appears later in the conversation.]`;
	}
	return `[older output dropped to keep this session inside its context window — ${record.label}, ${formatBytes(record.bytes)}. Re-run the tool if you still need it.]`;
}

/**
 * Results this round is allowed to drop, oldest first.
 *
 * Protected: anything already dropped, anything that errored (a failure the
 * model has not yet reacted to is the last thing to take away), and the newest
 * `keepRecentResults` — the live working set.
 *
 * Two exceptions reach inside that recent window, because both mark content
 * that is stale *now* regardless of age:
 *
 *   - images: a screenshot goes stale the moment the next one is taken, and
 *     costs ~1.2k tokens to keep saying so, so only the newest `keepImages`
 *     survive. In practice that only bites during a visual-iteration burst,
 *     which is exactly when it should.
 *   - superseded reads: a later read of the same file replaced this copy, so
 *     what is being protected would be the *stale* version of a file the model
 *     is probably editing.
 *
 * A third protection sits outside age altogether: `pinned` (toolCallIds
 * published on the "context-diet:pin" pi.events channel — see index.ts) marks
 * a result as protected by an outside decision, not by recency. The
 * motivating case is the inverse of the image rule above: a reference mockup
 * that must survive precisely because it is *old* — it has to outlive every
 * one of the agent's own newer, and by then more numerous, screenshots of its
 * own work. Checked first, ahead of the image and supersession rules, so a
 * pin wins over both rather than being folded into either.
 */
export function collectCandidates(
	messages: readonly AgentMessage[],
	evicted: ReadonlyMap<string, EvictionRecord>,
	settings: DietSettings,
	labels: ReadonlyMap<string, string>,
	superseded: ReadonlySet<string> = new Set(),
	pinned: ReadonlySet<string> = new Set(),
): EvictionRecord[] {
	const results: { index: number; message: ToolResultMessage }[] = [];
	for (const [index, message] of messages.entries()) {
		if (isToolResult(message)) results.push({ index, message });
	}

	const recentFrom = results.length - settings.keepRecentResults;
	const imagePositions = results.map((r, position) => (hasImage(r.message.content) ? position : -1)).filter((p) => p >= 0);
	// slice(-0) is slice(0) — the whole array — so keepImages: 0 has to be spelled
	// out, or asking to keep no screenshots would keep every one of them.
	const protectedImages = new Set(settings.keepImages > 0 ? imagePositions.slice(-settings.keepImages) : []);

	const candidates: EvictionRecord[] = [];
	for (const [position, { message }] of results.entries()) {
		if (evicted.has(message.toolCallId)) continue;
		if (message.isError) continue;
		if (pinned.has(message.toolCallId)) continue;

		const image = hasImage(message.content);
		const stale = superseded.has(message.toolCallId);
		const recent = position >= recentFrom;
		if (recent && !stale && (!image || protectedImages.has(position))) continue;

		const bytes = contentBytes(message.content);
		if (bytes < settings.minResultBytes) continue;

		const label = labels.get(message.toolCallId) ?? message.toolName;
		const record: EvictionRecord = { toolCallId: message.toolCallId, label, bytes, savedTokens: 0, ...(stale ? { superseded: true } : {}) };
		const saved = contentTokens(message.content) - Math.ceil(stubText(record).length / CONFIG.charsPerToken);
		if (saved <= 0) continue;

		candidates.push({ ...record, savedTokens: saved });
	}
	return candidates;
}

export function resolveBounds(contextWindow: number, settings: DietSettings): { highWater: number; target: number } {
	const highWater = settings.highWaterTokens || Math.round(contextWindow * settings.highWaterRatio);
	const target = settings.targetTokens || Math.round(contextWindow * settings.targetRatio);
	// A target at or above the high-water mark would re-trigger a round on every
	// call, which is the one failure mode that costs more than it saves.
	return { highWater, target: Math.min(target, Math.floor(highWater * 0.9)) };
}

/**
 * Decide a round. Returns null when nothing needs doing — the common case, and
 * the one that must stay cheap.
 *
 * Oldest-first is deliberate. A round invalidates the prompt cache from the
 * earliest message it touches, so the cost of a round is set by its oldest
 * eviction no matter how many follow. Given that, the right move is to take
 * everything old in one go and buy a long stable run afterwards, rather than
 * trim a little on every call and pay the same penalty each time.
 *
 * Superseded reads are swept even once the target is met: the round is paying
 * for a cache break anyway, and what they hold is a stale copy of a file a
 * later read replaced. They still never *trigger* a round on their own —
 * below the high-water mark they sit untouched, costing nothing extra.
 */
export function planDiet(args: {
	messages: readonly AgentMessage[];
	evicted: ReadonlyMap<string, EvictionRecord>;
	currentTokens: number;
	contextWindow: number;
	settings: DietSettings;
	/** toolCallIds protected by an outside decision — see collectCandidates. */
	pinned?: ReadonlySet<string>;
}): DietPlan | null {
	const { messages, evicted, currentTokens, contextWindow, settings, pinned = new Set() } = args;
	if (!settings.enabled || contextWindow <= 0) return null;

	const { highWater, target } = resolveBounds(contextWindow, settings);
	if (currentTokens <= highWater) return null;

	const labels = indexCallLabels(messages);
	const superseded = findSupersededReads(messages, indexReadSpans(messages));
	const candidates = collectCandidates(messages, evicted, settings, labels, superseded, pinned);

	const records: EvictionRecord[] = [];
	let projected = currentTokens;
	for (const candidate of candidates) {
		if (projected <= target && !candidate.superseded) continue;
		records.push(candidate);
		projected -= candidate.savedTokens;
	}
	if (records.length === 0) return null;

	return { records, fromTokens: currentTokens, toTokens: projected };
}

/**
 * Swap every evicted result for its stub, and strip thinking blocks from every
 * reasoning-dropped assistant message. Returns the input array untouched when
 * there is nothing to do, so the no-op path allocates nothing.
 *
 * Messages that survive are passed through by reference: pi hands this hook a
 * structuredClone and uses the return value for the request only, so sharing is
 * safe and session state is never what gets edited.
 */
export function applyDiet(
	messages: readonly AgentMessage[],
	evicted: ReadonlyMap<string, EvictionRecord>,
	reasoningDropped: ReadonlySet<string> = new Set(),
): AgentMessage[] {
	if (evicted.size === 0 && reasoningDropped.size === 0) return messages as AgentMessage[];
	return messages.map((message) => {
		if (isToolResult(message)) {
			const record = evicted.get(message.toolCallId);
			if (!record) return message;
			return { ...message, content: [{ type: "text", text: stubText(record) }] } satisfies ToolResultMessage;
		}
		if (isAssistant(message) && reasoningDropped.has(assistantKey(message))) {
			const content = message.content.filter((block) => block.type !== "thinking");
			if (content.length === message.content.length) return message;
			return { ...message, content };
		}
		return message;
	});
}

export function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/** "Context diet — dropped 38 stale results, 221k → 149k". */
export function dietLine(entry: DietEntry): string {
	const noun = entry.dropped === 1 ? "stale result" : "stale results";
	const reasoning = entry.reasoningDropped ? ` + reasoning from ${entry.reasoningDropped}` : "";
	return `Context diet — dropped ${entry.dropped} ${noun}${reasoning}, ${formatTokens(entry.fromTokens)} → ${formatTokens(entry.toTokens)}`;
}

/**
 * The hidden follow-up sent once per turn once rounds keep firing inside it —
 * see session.ts's escalateAfterRounds and index.ts for how it is delivered.
 * Wrapped like pi's other hidden reminders (ask-user's systemReminder is the
 * precedent) so it never renders in the transcript but still reaches the
 * model as an ordinary message in its own context.
 *
 * States the count and the approximate tokens because a bare "you are being
 * trimmed" is easy for a model to read past; a specific, escalating number
 * attached to its own recent behaviour is harder to. The delegation move is
 * hedged on the Workflow tool actually being there: this reminder fires in
 * any session, including ones with no Workflow tool at all or where its use
 * is opt-in-gated, and an unconditional "delegate to workflow agents" would
 * be advice the model cannot act on in exactly those cases. The other move —
 * stop opening new files and let the working set shrink on its own — always
 * applies, so it stays the fallback regardless.
 */
export function escalationReminder(roundsThisTurn: number, tokensThisTurn: number): string {
	const body =
		`Context has been trimmed ${roundsThisTurn} times this turn (~${formatTokens(tokensThisTurn)} tokens dropped). ` +
		"You are reading faster than the window holds. Change strategy: delegate self-contained subtasks (if the " +
		"Workflow tool is available), or finish and verify the current item before opening new files. " +
		"Re-reading dropped results will re-trigger trimming.";
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * What an attended user sees for the same event, in the notification tray
 * rather than a transcript line — a round on its own only ever prints a
 * muted row (see render.ts), which is easy to miss exactly when it matters
 * most: a turn that keeps re-triggering rounds instead of finishing.
 */
export function escalationNotice(roundsThisTurn: number, tokensThisTurn: number): string {
	return `Context diet escalated — trimmed ${roundsThisTurn}× this turn (~${formatTokens(tokensThisTurn)} dropped so far). Told the model to change strategy.`;
}

/**
 * A stable identity for an assistant message, so a reasoning drop can stick to
 * it across calls. Assistant messages carry no id; the first tool call's id is
 * unique and immutable, and the rare assistant message without one (the final
 * answer of a turn) falls back to its timestamp. A collision there could only
 * make two messages drop reasoning together — never resurrect any.
 */
export function assistantKey(message: AssistantMessage): string {
	for (const block of message.content) {
		if (block.type === "toolCall") return block.id;
	}
	return `ts:${message.timestamp}`;
}

/**
 * Which assistant messages a round should strip reasoning from: everything but
 * the newest `keepRecent`, minus what is already stripped.
 *
 * Decided only inside a round, exactly like result evictions. Deciding this
 * per call — "always the newest N" — would move the boundary forward on every
 * assistant message, mutating position N-from-the-end each call and breaking
 * the prompt cache there every single time. Sticky-and-swept-in-rounds is the
 * whole reason the diet saves money; reasoning follows the same rule.
 */
export function collectReasoningDrops(
	messages: readonly AgentMessage[],
	alreadyDropped: ReadonlySet<string>,
	keepRecent: number,
): { keys: string[]; savedTokens: number } {
	const withReasoning: { key: string; chars: number }[] = [];
	for (const message of messages) {
		if (!isAssistant(message)) continue;
		let chars = 0;
		for (const block of message.content) {
			if (block.type === "thinking") chars += (block.thinking?.length ?? 0) + (block.thinkingSignature?.length ?? 0);
		}
		if (chars > 0) withReasoning.push({ key: assistantKey(message), chars });
	}

	const cutoff = Math.max(0, withReasoning.length - Math.max(0, keepRecent));
	const keys: string[] = [];
	let savedTokens = 0;
	for (const { key, chars } of withReasoning.slice(0, cutoff)) {
		if (alreadyDropped.has(key)) continue;
		keys.push(key);
		savedTokens += Math.ceil(chars / CONFIG.charsPerToken);
	}
	return { keys, savedTokens };
}

/**
 * Fallback size estimate, used only when pi cannot report a real one — the gap
 * between a compaction and the next response. It omits the system prompt and
 * tool schemas, so it reads low by ~12k; that only matters if a round were
 * decided from it, and at that point in a session there is nothing near the
 * high-water mark anyway.
 */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		if (isToolResult(message)) {
			tokens += contentTokens(message.content);
			continue;
		}
		if (isAssistant(message)) {
			for (const block of message.content) {
				if (block.type === "text") tokens += Math.ceil(block.text.length / CONFIG.charsPerToken);
				else if (block.type === "thinking")
					tokens += Math.ceil(((block.thinking?.length ?? 0) + (block.thinkingSignature?.length ?? 0)) / CONFIG.charsPerToken);
				else if (block.type === "toolCall") tokens += Math.ceil(JSON.stringify(block.arguments ?? {}).length / CONFIG.charsPerToken);
			}
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") tokens += Math.ceil(content.length / CONFIG.charsPerToken);
		else if (Array.isArray(content)) tokens += contentTokens(content as ResultContent);
	}
	return tokens;
}
