/**
 * Memory for pi — as a start, reads another agent's store on this machine.
 *
 * That store keeps per-project memory in ~/.claude/projects/<slug>/memory/: a
 * MEMORY.md index (loaded into context each session) plus per-fact markdown
 * files with YAML frontmatter (name / description / type, body with **Why:** /
 * **How to apply:**). This extension finds the memory that matches pi's current
 * project (by the same cwd→slug encoding that store uses), assembles it within
 * a budget, and appends it to pi's system prompt each turn (cached, not resent).
 *
 * pi already loads project CLAUDE.md/AGENTS.md as context files, so those are
 * left alone; this adds the dedicated memory store on top, plus a global
 * ~/.claude/CLAUDE.md if one exists.
 *
 * Reading is the "for a start" scope; writing pi's own memory can layer on later
 * over the same format.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const SETTINGS_KEY = "memory";

export const CONFIG = {
	/** Header that frames the injected block for the model. */
	header:
		"# Memory\n\nYour persistent memory for this project, loaded from the memory store on this machine. Treat it as background knowledge that reflects what was true when it was written — verify specifics (files, commands, flags) against the current code before relying on them.",
} as const;

export interface MemorySettings {
	/** Master switch. Default true. */
	enabled: boolean;
	/** Include full fact-file bodies, not just the MEMORY.md index. Default true. */
	includeFacts: boolean;
	/** Character budget for the injected memory block. Default 24000. */
	maxChars: number;
	/** Root of the store's data dir. Default ~/.claude. */
	claudeHome: string;
}

export function defaultSettings(): MemorySettings {
	return {
		enabled: true,
		includeFacts: true,
		maxChars: 24_000,
		claudeHome: join(homedir(), ".claude"),
	};
}
