/**
 * Reading and assembling stored memory into one injectable block.
 *
 * readMemory() touches the filesystem; parseFrontmatter() and assemble() are
 * pure so the shaping and budgeting are testable without a memory directory.
 * A fact file's YAML frontmatter is parsed leniently — the store has written
 * both a flat `type:` and a nested `metadata:\n  type:`, and older files have no
 * frontmatter at all — so anything unrecognised just falls back to the filename
 * and the raw body.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG } from "./config.ts";

export interface Fact {
	file: string;
	name?: string;
	type?: string;
	description?: string;
	body: string;
}

export interface Frontmatter {
	name?: string;
	description?: string;
	type?: string;
	body: string;
}

/** Extract name/description/type from a leading `--- ... ---` block, plus the body. */
export function parseFrontmatter(text: string): Frontmatter {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { body: text.trim() };
	const [, front, body] = match;
	const field = (key: string): string | undefined => {
		// Matches `key: value` at the start of a line or nested one level (under metadata:).
		const re = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "mi");
		const m = front.match(re);
		return m ? m[1].replace(/^["']|["']$/g, "").trim() || undefined : undefined;
	};
	return {
		name: field("name"),
		description: field("description"),
		type: field("type"),
		body: body.trim(),
	};
}

export interface RawMemory {
	memoryMd?: string;
	facts: Fact[];
}

/** Read MEMORY.md and every other *.md fact file from a memory directory. */
export function readMemory(memoryDir: string): RawMemory {
	let memoryMd: string | undefined;
	const facts: Fact[] = [];
	let names: string[];
	try {
		names = readdirSync(memoryDir).filter((name) => name.toLowerCase().endsWith(".md"));
	} catch {
		return { facts: [] };
	}
	names.sort();
	for (const name of names) {
		let text: string;
		try {
			text = readFileSync(join(memoryDir, name), "utf8");
		} catch {
			continue;
		}
		if (name === "MEMORY.md") {
			memoryMd = text.trim();
			continue;
		}
		const parsed = parseFrontmatter(text);
		facts.push({ file: basename(name), name: parsed.name, type: parsed.type, description: parsed.description, body: parsed.body });
	}
	return { memoryMd, facts };
}

export interface AssembleInput {
	memoryMd?: string;
	facts: Fact[];
	globalClaudeMd?: string;
	includeFacts: boolean;
	maxChars: number;
}

export interface Assembled {
	text: string;
	truncated: boolean;
	factCount: number;
	hasIndex: boolean;
}

/** Build the injected memory block within `maxChars`, dropping overflow facts. */
export function assemble(input: AssembleInput): Assembled {
	const parts: string[] = [CONFIG.header];
	let used = CONFIG.header.length;
	let truncated = false;
	let factCount = 0;

	const tryAdd = (block: string): boolean => {
		if (used + block.length + 2 > input.maxChars) return false;
		parts.push(block);
		used += block.length + 2;
		return true;
	};

	if (input.globalClaudeMd?.trim()) {
		tryAdd(`## Global (CLAUDE.md)\n\n${input.globalClaudeMd.trim()}`);
	}

	const hasIndex = Boolean(input.memoryMd?.trim());
	if (hasIndex) {
		if (!tryAdd(`## Index (MEMORY.md)\n\n${input.memoryMd!.trim()}`)) truncated = true;
	}

	if (input.includeFacts && input.facts.length > 0) {
		let headingAdded = false;
		for (const fact of input.facts) {
			const heading = fact.name ?? fact.file;
			const tag = fact.type ? ` [${fact.type}]` : "";
			const block = `### ${heading}${tag}\n${fact.body}`.trim();
			// The "## Facts" heading is only charged once, before the first fact fits.
			const need = (headingAdded ? 0 : "## Facts".length + 2) + block.length + 2;
			if (used + need > input.maxChars) {
				truncated = true;
				continue;
			}
			if (!headingAdded) {
				parts.push("## Facts");
				used += "## Facts".length + 2;
				headingAdded = true;
			}
			parts.push(block);
			used += block.length + 2;
			factCount++;
		}
	}

	if (truncated) parts.push("_(Some memory was omitted to fit the context budget; raise memory.maxChars or set memory.includeFacts=false to see the index only.)_");

	return { text: parts.join("\n\n"), truncated, factCount, hasIndex };
}
