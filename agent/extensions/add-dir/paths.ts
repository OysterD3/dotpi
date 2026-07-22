/**
 * Path expansion and containment.
 *
 * Ported from Claude Code's own helpers rather than re-invented, because the
 * containment test decides whether adding a directory is a no-op, and getting it
 * subtly wrong is how you end up with `/add-dir .` silently adding the cwd twice
 * or refusing a directory that is genuinely new.
 *
 * The one non-obvious rule is the `/private` normalization. On macOS `/tmp` and
 * `/var` are symlinks into `/private`, so `path.resolve` and `realpath` disagree
 * about the same directory. Claude Code rewrites both sides before comparing;
 * without it, adding `/tmp/work` while `/private/tmp/work` is already in the
 * workspace looks like a new directory.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, posix, relative, resolve, sep } from "node:path";

/**
 * Expand `~` and resolve against a base directory.
 *
 * Mirrors Claude Code's expansion, including the null-byte rejection: a NUL in a
 * path is never legitimate here and Node's fs calls throw on it anyway, so it is
 * better to fail with a clear message than a stack trace.
 */
export function expandPath(input: string, base: string): string {
	if (input.includes("\0") || base.includes("\0")) throw new Error("Path contains null bytes");

	const trimmed = input.trim();
	if (!trimmed) return resolve(normalize(base));
	if (trimmed === "~") return resolve(homedir());
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));

	return resolve(base, trimmed);
}

/** `/private/var/...` and `/private/tmp/...` name the same places as `/var` and `/tmp`. */
function unprivate(path: string): string {
	return path.replace(/^\/private\/var\//, "/var/").replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
}

/** Does `path` contain a `..` segment? */
function hasParentSegment(path: string): boolean {
	return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path);
}

/**
 * Is `child` the same directory as `parent`, or somewhere beneath it?
 *
 * Case-sensitive by default. macOS filesystems are usually case-insensitive, but
 * folding by default would make `/add-dir ~/Work` a no-op when `~/work` is
 * already present even on the case-sensitive volumes where those are two real,
 * different directories.
 */
export function isWithin(child: string, parent: string, options?: { caseFold?: boolean }): boolean {
	const caseFold = options?.caseFold ?? false;

	const from = unprivate(parent);
	const to = unprivate(child);
	const rel = caseFold
		? posix.relative(from.toLowerCase(), to.toLowerCase())
		: posix.relative(from, to);

	if (rel === "") return true;
	if (hasParentSegment(rel)) return false;
	return !posix.isAbsolute(rel);
}

/** Shorten a home-relative path for display, as `~/projects/app`. */
export function tildify(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
	return path;
}

/** Show a path relative to the cwd when it is inside it, else absolute (tildified). */
export function displayPath(path: string, cwd: string): string {
	if (path === cwd) return ".";
	if (isWithin(path, cwd)) {
		const rel = relative(cwd, path);
		if (rel && !isAbsolute(rel)) return rel;
	}
	return tildify(path);
}
