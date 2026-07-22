/**
 * What the model is told about the added directories.
 *
 * This is where `/add-dir` earns its keep in pi. pi's tools are not fenced to the
 * cwd — `read`, `edit` and `bash` will happily take an absolute path anywhere —
 * so adding a directory is not about lifting a restriction. It is about the model
 * knowing the directory is in scope at all, and about its AGENTS.md being loaded
 * the way the project's own is. Claude Code does the same second part; it keeps a
 * separate list of added directories specifically to pick up their CLAUDE.md.
 *
 * The block is appended after pi's `Current working directory:` line, so it reads
 * as a continuation of the same thought. Because it is appended and the directory
 * set rarely changes mid-session, it does not disturb prompt caching.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, CONTEXT_FILES } from "./config.ts";

export type ContextFile = {
	path: string;
	content: string;
	truncated: boolean;
};

/** pi's own rule: first candidate filename that exists in the directory wins. */
export function findContextFile(dir: string): string | undefined {
	for (const name of CONTEXT_FILES) {
		const path = join(dir, name);
		try {
			if (existsSync(path) && statSync(path).isFile()) return path;
		} catch {
			// Unreadable is the same as absent for our purposes.
		}
	}
	return undefined;
}

/**
 * Read the guidance file for each directory, within a total budget.
 *
 * The caps matter: these files are re-sent every turn, and a directory added on a
 * whim should not be able to quietly double the cost of the conversation.
 */
export function loadContextFiles(dirs: string[]): ContextFile[] {
	if (!CONFIG.loadContextFiles) return [];

	const files: ContextFile[] = [];
	let budget = CONFIG.contextFileTotalChars;

	for (const dir of dirs) {
		if (budget <= 0) break;

		const path = findContextFile(dir);
		if (!path) continue;

		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}

		const limit = Math.min(CONFIG.contextFileMaxChars, budget);
		const truncated = raw.length > limit;
		const content = truncated ? raw.slice(0, limit) : raw;
		budget -= content.length;
		files.push({ path, content, truncated });
	}

	return files;
}

/** The text appended to pi's system prompt, or "" when there is nothing to add. */
export function buildPromptBlock(dirs: string[]): string {
	if (dirs.length === 0) return "";

	const list = dirs.map((dir) => `- ${dir.replace(/\\/g, "/")}`).join("\n");
	let block = `\n\nAdditional working directories:\n${list}\n\nThese are part of the workspace for this session. Read, search and edit files under them as you would files under the current working directory. Refer to them by absolute path, since they are outside it.`;

	const files = loadContextFiles(dirs);
	if (files.length > 0) {
		block += "\n\n<project_context>\n\nInstructions from the additional working directories:\n\n";
		for (const file of files) {
			const note = file.truncated ? " truncated=\"true\"" : "";
			block += `<project_instructions path="${file.path}"${note}>\n${file.content}\n</project_instructions>\n\n`;
		}
		block += "</project_context>";
	}

	return block;
}
