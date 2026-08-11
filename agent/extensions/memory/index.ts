/**
 * memory — a per-project memory store pi reads every turn and can write.
 *
 * At session start it resolves which store this project reads from
 * (pi's own once it exists, the other agent's until then), reads MEMORY.md and
 * the fact files (load.ts), and assembles them within a budget. Each turn,
 * before_agent_start appends that block to the system prompt — so it is cached
 * across the turn rather than resent as a message. `/memory` shows what is
 * loaded and where from.
 *
 * The `memory` tool is the write path. Its first write forks: the other
 * agent's files are cloned into pi's store and pi reads the copy from then on
 * (store.ts explains why the clone is atomic and why there is no merge back).
 * A write refreshes the assembled block, so the next request carries it — and
 * pays a prompt-cache miss for the change, which is the price of memory that
 * is actually current.
 *
 * Settings (agent settings.json — per-machine):
 *   memory.enabled       boolean, default true
 *   memory.includeFacts  boolean, default true (full fact bodies, not just the index)
 *   memory.maxChars      number, default 24000 (budget for the injected block)
 *   memory.claudeHome    string, default ~/.claude (the store forked from)
 *   memory.piHome        string, default <XDG_CONFIG_HOME or ~/.config>/pi
 *   memory.writable      boolean, default true (offer the tool at all)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type MemorySettings, SETTINGS_KEY, defaultSettings } from "./config.ts";
import { assemble, type Assembled, readMemory } from "./load.ts";
import { globalClaudeMd, memoryDirFor } from "./locate.ts";
import { deleteFile, ensureStore, listFiles, piMemoryDir, readFile, readOrigin, safeFileName, writeFile } from "./store.ts";

export function loadSettings(agentDir: string): MemorySettings {
	const base = defaultSettings();
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : base.enabled,
			includeFacts: typeof block?.includeFacts === "boolean" ? block.includeFacts : base.includeFacts,
			maxChars: typeof block?.maxChars === "number" && Number.isFinite(block.maxChars) && block.maxChars > 0 ? Math.floor(block.maxChars) : base.maxChars,
			claudeHome: typeof block?.claudeHome === "string" && block.claudeHome.trim() ? block.claudeHome.trim() : base.claudeHome,
			piHome: typeof block?.piHome === "string" && block.piHome.trim() ? block.piHome.trim() : base.piHome,
			writable: typeof block?.writable === "boolean" ? block.writable : base.writable,
		};
	} catch {
		return base;
	}
}

export interface LoadedMemory extends Assembled {
	source?: string;
	globalSource?: string;
	/** True once pi's own store is what is being read. */
	own: boolean;
	/** Where pi's store was forked from, when it was forked. */
	forkedFrom?: string;
	forkedAt?: string;
}

/**
 * Which directory this project's memory is read from.
 *
 * pi's own wins the moment it exists — that is what makes a fork a fork. Until
 * then the other agent's store is read in place, unchanged.
 */
export function resolveSource(cwd: string, settings: MemorySettings): { dir?: string; own: boolean } {
	const mine = piMemoryDir(cwd, settings.piHome);
	if (existsSync(mine)) return { dir: mine, own: true };
	return { dir: memoryDirFor(cwd, settings.claudeHome), own: false };
}

/** Locate, read, and assemble the memory for a cwd. Returns undefined when off/empty. */
export function loadMemoryFor(cwd: string, settings: MemorySettings): LoadedMemory | undefined {
	if (!settings.enabled) return undefined;
	const { dir, own } = resolveSource(cwd, settings);
	const globalPath = globalClaudeMd(settings.claudeHome);
	let globalText: string | undefined;
	if (globalPath) {
		try {
			globalText = readFileSync(globalPath, "utf8");
		} catch {
			globalText = undefined;
		}
	}
	const raw = dir ? readMemory(dir) : { facts: [] };
	const hasAnything = Boolean(raw.memoryMd) || raw.facts.length > 0 || Boolean(globalText?.trim());
	if (!hasAnything) return undefined;

	const assembled = assemble({
		memoryMd: raw.memoryMd,
		facts: raw.facts,
		globalClaudeMd: globalText,
		includeFacts: settings.includeFacts,
		maxChars: settings.maxChars,
	});
	const origin = own && dir ? readOrigin(dir) : undefined;
	return { ...assembled, source: dir, globalSource: globalPath, own, forkedFrom: origin?.clonedFrom, forkedAt: origin?.clonedAt };
}

const TOOL_DESCRIPTION = [
	"Add to, change, or remove this project's persistent memory. Memory survives the session; the block in your system prompt is what it currently holds.",
	"",
	"Each fact is one markdown file with YAML frontmatter:",
	"",
	"---",
	"name: <short-kebab-case-slug>",
	"description: <one line, used to judge relevance later>",
	"metadata:",
	"  type: user | feedback | project | reference",
	"---",
	"",
	"<the fact. For feedback and project, follow with **Why:** and **How to apply:** lines.>",
	"",
	"`MEMORY.md` is the index that is always loaded: every fact file needs a one-line pointer in it (`- [Title](file.md) — hook`), which you maintain with this same tool. Read a file before rewriting it; the block in your prompt may have been truncated to fit its budget.",
	"",
	"Save what stays true and is not already recorded: how the user works, a decision and the reason behind it, a project constraint that is not derivable from the code. Do not save what the repository already says (structure, past fixes, git history), or anything that only matters to this conversation.",
	"",
	"The first write clones the memory another agent on this machine kept for this project into pi's own store; after that the two are independent.",
].join("\n");

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = loadSettings(agentDir);
	let loaded: LoadedMemory | undefined;
	/** The cwd of the running session — tools get a ctx, session_start sets this for the rest. */
	let cwd = process.cwd();

	const refresh = (context: { cwd: string; hasUI?: boolean; ui?: ExtensionContext["ui"] }): void => {
		settings = loadSettings(agentDir);
		cwd = context.cwd;
		loaded = loadMemoryFor(cwd, settings);
		if (context.hasUI && context.ui) {
			context.ui.setStatus("memory", loaded ? `✦ memory${loaded.factCount > 0 ? `: ${loaded.factCount}` : ""}` : undefined);
		}
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));

	pi.on("before_agent_start", (event) => {
		if (!settings.enabled || !loaded?.text) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${loaded.text}` };
	});

	/**
	 * The write path, and the only place the fork happens.
	 *
	 * `read` is not a convenience: assemble() drops facts past maxChars, so a
	 * model asked to update one that was dropped would otherwise rewrite it
	 * from memory of a file it never saw.
	 */
	if (settings.enabled && settings.writable) {
		pi.registerTool({
			name: "memory",
			label: "Memory",
			description: TOOL_DESCRIPTION,
			parameters: Type.Object({
				action: Type.Union([Type.Literal("write"), Type.Literal("delete"), Type.Literal("read"), Type.Literal("list")], {
					description: "write replaces a whole file, delete removes one, read returns one, list names them all",
				}),
				file: Type.Optional(Type.String({ description: "File name inside the memory store, e.g. MEMORY.md or prefers-tabs.md. Required except for list." })),
				content: Type.Optional(Type.String({ description: "The complete new contents of the file. Required for write." })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx?: ExtensionContext) {
				const here = ctx?.cwd ?? cwd;
				const action = params.action;
				const dir = piMemoryDir(here, settings.piHome);

				// Re-checked here, not only at registration: settings reload on
				// every session_start, and writing a store that
				// before_agent_start will never inject would report success for
				// memory the model is not going to see.
				if (!settings.enabled) {
					return {
						content: [{ type: "text", text: "Memory is turned off (memory.enabled is false), so nothing was read or written." }],
						details: { action, ok: false },
						isError: true,
					};
				}

				if (action === "list") {
					const { dir: from, own } = resolveSource(here, settings);
					const names = from ? listFiles(from) : [];
					const text = names.length > 0 ? `${own ? "pi's" : "inherited"} memory at ${from}:\n${names.join("\n")}` : "No memory files yet.";
					return { content: [{ type: "text", text }], details: { action, ok: true, count: names.length } };
				}

				const name = safeFileName(params.file ?? "");
				if (!name) {
					return { content: [{ type: "text", text: `Refused: "${params.file ?? ""}" is not a bare markdown file name (one path component, ending in .md).` }], details: { action, ok: false }, isError: true };
				}

				if (action === "read") {
					const { dir: from } = resolveSource(here, settings);
					const text = from ? readFile(from, name) : undefined;
					return text === undefined
						? { content: [{ type: "text", text: `No ${name} in memory.` }], details: { action, ok: false }, isError: true }
						: { content: [{ type: "text", text }], details: { action, ok: true, file: name } };
				}

				// Everything below mutates, so this is where the fork happens.
				const inherited = memoryDirFor(here, settings.claudeHome);
				let cloned = false;
				try {
					cloned = ensureStore(dir, inherited).cloned;
				} catch (error) {
					return { content: [{ type: "text", text: `Could not create pi's memory store at ${dir}: ${error instanceof Error ? error.message : String(error)}` }], details: { action, ok: false }, isError: true };
				}

				let result: string;
				if (action === "write") {
					if (typeof params.content !== "string" || params.content.trim().length === 0) {
						return { content: [{ type: "text", text: "Refused: write needs the file's complete new content." }], details: { action, ok: false }, isError: true };
					}
					try {
						writeFile(dir, name, params.content);
					} catch (error) {
						return { content: [{ type: "text", text: `Could not write ${name}: ${error instanceof Error ? error.message : String(error)}` }], details: { action, ok: false }, isError: true };
					}
					result = `Wrote ${name}.`;
				} else {
					result = deleteFile(dir, name) ? `Deleted ${name}.` : `No ${name} to delete.`;
				}

				refresh(ctx ? ctx : { cwd: here });
				const forkNote = cloned ? ` Forked ${inherited} into ${dir} first; the two are independent from now on.` : "";
				const text = `${result}${forkNote} Memory now holds ${loaded?.factCount ?? 0} fact(s) and is in your next request.`;
				return { content: [{ type: "text", text }], details: { action, ok: true, file: name, cloned } };
			},
		});
	}

	const status = (at: string): string => {
		if (!settings.enabled) return "Memory is off (memory.enabled is false).";
		const mine = piMemoryDir(at, settings.piHome);
		if (!loaded) return `No memory found for ${at}. (pi's store would be ${mine}.)`;
		const bits = [`${loaded.factCount} fact${loaded.factCount === 1 ? "" : "s"}`, `${loaded.text.length} chars`];
		if (loaded.hasIndex) bits.push("index");
		if (loaded.globalSource) bits.push("global CLAUDE.md");
		if (loaded.truncated) bits.push("truncated to budget");
		if (!settings.writable) bits.push("read-only");
		const where = loaded.own
			? `pi's own store ${loaded.source}`
			: loaded.source
				? `${loaded.source} — another agent's, read-only until the first write forks it into ${mine}`
				: `${loaded.globalSource} only — this project has no memory directory yet`;
		const fork = loaded.forkedFrom ? ` Forked from ${loaded.forkedFrom} on ${loaded.forkedAt?.slice(0, 10)}; changes made there since are not read here.` : "";
		return `Memory loaded (${bits.join(", ")}) from ${where}.${fork}`;
	};

	pi.registerCommand("memory", {
		description: "Show the memory loaded for this project (/memory [show|reload|status])",
		getArgumentCompletions: (prefix: string) =>
			["show", "reload", "status"].filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "reload") {
				refresh(ctx);
				ctx.ui.notify(status(ctx.cwd), "info");
				return;
			}
			if (arg === "show") {
				refresh(ctx);
				ctx.ui.notify(loaded?.text ?? status(ctx.cwd), "info");
				return;
			}
			ctx.ui.notify(status(ctx.cwd), "info");
		},
	});
}
