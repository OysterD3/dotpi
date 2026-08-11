/**
 * pi's own memory store, and the copy-on-write fork from the other agent's.
 *
 * ## Where
 *
 * `<XDG_CONFIG_HOME or ~/.config>/pi/memory/<slug>/`, the same place and for
 * the same reasons as skill-loading's store: `agent/settings.json` is tracked
 * so a clone reproduces this setup, and what pi remembers about *your* projects
 * is the opposite kind of fact — machine-local, private, and not something a
 * `git add -A` should ever publish.
 *
 * The slug is the primary cwd encoding only. Reading the other agent's store
 * probes two candidates because that encoder is not ours and has been observed
 * to disagree with itself over underscores; ours is ours, so it is written and
 * read at one deterministic path with no probing.
 *
 * ## The fork
 *
 * Until pi writes, there is nothing here and memory is read out of the other
 * agent's store. The first mutation clones every `*.md` across and from then on
 * pi's copy is the only one read — a fork, not a sync. That is the honest
 * reading of "clone it and mutate it": there is no merge, and facts the other
 * agent adds after the fork are not visible here. `.origin.json` records what
 * was forked and when so `/memory` can say so out loud.
 *
 * ## Why the clone is atomic
 *
 * Precedence is "pi's directory exists → pi's store wins". A clone that copied
 * three files of twelve and then crashed would leave a directory that exists,
 * wins, and hides the nine facts that never made it — memory loss with no error
 * anywhere. So the copy is built under a temp sibling and renamed into place:
 * the directory either does not exist or is complete. Individual writes use the
 * same temp-file-rename the provider extension uses, for the same reason.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `<XDG_CONFIG_HOME or ~/.config>/pi`. */
export function defaultPiHome(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
	return join(base, "pi");
}

/** The primary cwd→slug encoding, shared with locate.ts's first candidate. */
export function piSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Where pi keeps this project's memory. Not created by asking. */
export function piMemoryDir(cwd: string, piHome: string): string {
	return join(piHome, "memory", piSlug(cwd));
}

export type Origin = {
	/** The directory this store was forked from, if it was forked. */
	clonedFrom: string;
	/** ISO date of the fork. */
	clonedAt: string;
};

const ORIGIN = ".origin.json";

/** Not a `*.md` file, so it can never be read back as a fact. */
export function readOrigin(dir: string): Origin | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(dir, ORIGIN), "utf8")) as Partial<Origin>;
		return typeof raw.clonedFrom === "string" && typeof raw.clonedAt === "string" ? { clonedFrom: raw.clonedFrom, clonedAt: raw.clonedAt } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Make sure pi's store exists, forking `source` into it the first time.
 *
 * Returns whether this call did the cloning, so the caller can say so once
 * rather than on every write.
 */
export function ensureStore(dir: string, source: string | undefined, now: () => Date = () => new Date()): { cloned: boolean } {
	if (existsSync(dir)) return { cloned: false };

	const parent = join(dir, "..");
	mkdirSync(parent, { recursive: true });

	// Nothing to fork from: an empty store is still a store.
	if (!source || !existsSync(source)) {
		mkdirSync(dir, { recursive: true });
		return { cloned: false };
	}

	const staging = mkdtempSync(join(parent, ".tmp-clone-"));
	try {
		let names: string[] = [];
		try {
			names = readdirSync(source).filter((name) => name.toLowerCase().endsWith(".md"));
		} catch {
			names = [];
		}
		for (const name of names) copyFileSync(join(source, name), join(staging, name));
		const origin: Origin = { clonedFrom: source, clonedAt: now().toISOString() };
		writeFileSync(join(staging, ORIGIN), `${JSON.stringify(origin, null, 2)}\n`, "utf8");

		// Re-checked, not assumed: another pi may have forked the same project
		// between the first check and here, and rename onto a non-empty
		// directory fails anyway.
		if (existsSync(dir)) {
			rmSync(staging, { recursive: true, force: true });
			return { cloned: false };
		}
		renameSync(staging, dir);
		return { cloned: true };
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

/**
 * A filename the model is allowed to name.
 *
 * The model picks these, so the guard is not politeness: `../../.ssh/config` or
 * `notes.md/../../x` must not resolve out of the store. One path component,
 * markdown only, no separators and no dots that could climb.
 */
export function safeFileName(raw: string): string | undefined {
	const name = raw.trim();
	if (!name || name.length > 128) return undefined;
	if (name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
	if (name === "." || name === ".." || name.startsWith(".")) return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return undefined;
	if (name.includes("..")) return undefined;
	return name;
}

/** Write one file, temp-then-rename so a reader never sees half of it. */
export function writeFile(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	const target = join(dir, name);
	const temp = `${target}.tmp-${process.pid}`;
	writeFileSync(temp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	renameSync(temp, target);
}

/** Delete one file. Returns false when it was not there — not an error. */
export function deleteFile(dir: string, name: string): boolean {
	try {
		unlinkSync(join(dir, name));
		return true;
	} catch {
		return false;
	}
}

export function readFile(dir: string, name: string): string | undefined {
	try {
		return readFileSync(join(dir, name), "utf8");
	} catch {
		return undefined;
	}
}

/** Every `*.md` in the store, sorted. */
export function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}
