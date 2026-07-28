/**
 * Finding the stored memory that belongs to pi's current project.
 *
 * The store encodes a project's cwd into its data-dir name by replacing every
 * non-alphanumeric character with "-": /Users/me/.pi → -Users-me--pi. That
 * reproduces every real directory observed on disk. Underscore-containing paths
 * are the one ambiguity (some code paths keep "_"), so a second
 * candidate that preserves "_" and "-" is tried too, and whichever memory
 * directory actually exists wins.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Candidate slugs for a cwd, most-likely first. */
export function projectSlugs(cwd: string): string[] {
	const primary = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	const keepUnderscore = cwd.replace(/[^a-zA-Z0-9_-]/g, "-");
	return [...new Set([primary, keepUnderscore])];
}

/** The first existing `<claudeHome>/projects/<slug>/memory` for this cwd, if any. */
export function memoryDirFor(cwd: string, claudeHome: string): string | undefined {
	for (const slug of projectSlugs(cwd)) {
		const dir = join(claudeHome, "projects", slug, "memory");
		if (existsSync(dir)) return dir;
	}
	return undefined;
}

/** Global user memory, if present (~/.claude/CLAUDE.md). */
export function globalClaudeMd(claudeHome: string): string | undefined {
	const path = join(claudeHome, "CLAUDE.md");
	return existsSync(path) ? path : undefined;
}
