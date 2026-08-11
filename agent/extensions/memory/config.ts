/**
 * Memory for pi — its own store, forked from another agent's when there is one.
 *
 * Another agent on this machine keeps per-project memory in
 * ~/.claude/projects/<slug>/memory/: a MEMORY.md index (loaded into context
 * each session) plus per-fact markdown files with YAML frontmatter (name /
 * description / type, body with **Why:** / **How to apply:**). This extension
 * finds the memory that matches pi's current project (by the same cwd→slug
 * encoding that store uses), assembles it within a budget, and appends it to
 * pi's system prompt each turn (cached, not resent).
 *
 * pi is not a reader of it any more. The `memory` tool writes, and the first
 * write forks: the other agent's files are cloned into pi's own store
 * (store.ts) and every read from then on comes from the copy. Nothing is ever
 * written back to the other agent's directory — pi keeps its own memory, it
 * does not edit someone else's.
 *
 * pi already loads project CLAUDE.md/AGENTS.md as context files, so those are
 * left alone; this adds the dedicated memory store on top, plus a global
 * ~/.claude/CLAUDE.md if one exists. The global file is read where it lies and
 * is never cloned or written — it is the user's, and it is not project memory.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPiHome } from "./store.ts";

export const SETTINGS_KEY = "memory";

export const CONFIG = {
	/**
	 * Header that frames the injected block for the model.
	 *
	 * Short on purpose: it is paid for on every request of the session, so it
	 * carries only what changes behaviour when the model has not asked — that
	 * this is memory, that it can be stale, and that there is a tool to change
	 * it. The format rules and the what-to-save judgement live in the tool's
	 * own description, where they are read at the moment they are needed.
	 */
	header:
		"# Memory\n\nYour persistent memory for this project, loaded from pi's memory store on this machine. It reflects what was true when it was written — verify specifics (files, commands, flags) against the current code before relying on them. Call the `memory` tool to add, change or remove what is here.",
} as const;

export interface MemorySettings {
	/** Master switch. Default true. */
	enabled: boolean;
	/** Include full fact-file bodies, not just the MEMORY.md index. Default true. */
	includeFacts: boolean;
	/** Character budget for the injected memory block. Default 24000. */
	maxChars: number;
	/** Root of the other agent's data dir, read until pi's store is forked. Default ~/.claude. */
	claudeHome: string;
	/** Root of pi's own store. Default <XDG_CONFIG_HOME or ~/.config>/pi. */
	piHome: string;
	/** Whether the model may write memory. Default true. */
	writable: boolean;
}

export function defaultSettings(): MemorySettings {
	return {
		enabled: true,
		includeFacts: true,
		maxChars: 24_000,
		claudeHome: join(homedir(), ".claude"),
		piHome: defaultPiHome(),
		writable: true,
	};
}
