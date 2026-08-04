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

export function stubText(record: EvictionRecord): string {
	return `[older output dropped to keep this session inside its context window — ${record.label}, ${formatBytes(record.bytes)}. Re-run the tool if you still need it.]`;
}

/**
 * Results this round is allowed to drop, oldest first.
 *
 * Protected: anything already dropped, anything that errored (a failure the
 * model has not yet reacted to is the last thing to take away), and the newest
 * `keepRecentResults` — the live working set.
 *
 * Images are the exception to that last rule. A screenshot goes stale the
 * moment the next one is taken, and costs ~1.2k tokens to keep saying so, so
 * only the newest `keepImages` of them survive even when they sit inside the
 * recent window. In practice that only bites during a visual-iteration burst,
 * which is exactly when it should.
 */
export function collectCandidates(
	messages: readonly AgentMessage[],
	evicted: ReadonlyMap<string, EvictionRecord>,
	settings: DietSettings,
	labels: ReadonlyMap<string, string>,
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

		const image = hasImage(message.content);
		const recent = position >= recentFrom;
		if (recent && (!image || protectedImages.has(position))) continue;

		const bytes = contentBytes(message.content);
		if (bytes < settings.minResultBytes) continue;

		const label = labels.get(message.toolCallId) ?? message.toolName;
		const record: EvictionRecord = { toolCallId: message.toolCallId, label, bytes, savedTokens: 0 };
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
 */
export function planDiet(args: {
	messages: readonly AgentMessage[];
	evicted: ReadonlyMap<string, EvictionRecord>;
	currentTokens: number;
	contextWindow: number;
	settings: DietSettings;
}): DietPlan | null {
	const { messages, evicted, currentTokens, contextWindow, settings } = args;
	if (!settings.enabled || contextWindow <= 0) return null;

	const { highWater, target } = resolveBounds(contextWindow, settings);
	if (currentTokens <= highWater) return null;

	const labels = indexCallLabels(messages);
	const candidates = collectCandidates(messages, evicted, settings, labels);

	const records: EvictionRecord[] = [];
	let projected = currentTokens;
	for (const candidate of candidates) {
		if (projected <= target) break;
		records.push(candidate);
		projected -= candidate.savedTokens;
	}
	if (records.length === 0) return null;

	return { records, fromTokens: currentTokens, toTokens: projected };
}

/**
 * Swap every evicted result for its stub. Returns the input array untouched
 * when nothing is evicted, so the no-op path allocates nothing.
 *
 * Messages that survive are passed through by reference: pi hands this hook a
 * structuredClone and uses the return value for the request only, so sharing is
 * safe and session state is never what gets edited.
 */
export function applyDiet(messages: readonly AgentMessage[], evicted: ReadonlyMap<string, EvictionRecord>): AgentMessage[] {
	if (evicted.size === 0) return messages as AgentMessage[];
	return messages.map((message) => {
		if (!isToolResult(message)) return message;
		const record = evicted.get(message.toolCallId);
		if (!record) return message;
		return { ...message, content: [{ type: "text", text: stubText(record) }] } satisfies ToolResultMessage;
	});
}

export function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/** "Context diet — dropped 38 stale results, 221k → 149k". */
export function dietLine(entry: DietEntry): string {
	const noun = entry.dropped === 1 ? "stale result" : "stale results";
	return `Context diet — dropped ${entry.dropped} ${noun}, ${formatTokens(entry.fromTokens)} → ${formatTokens(entry.toTokens)}`;
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
