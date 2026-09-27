/**
 * The path a path tool will actually touch, read the way pi reads it.
 *
 * Its own file because two others need it and one of them imports the other:
 * rules.ts matches rules against it, and workspace.ts (which imports rules.ts)
 * decides what `acceptChanges` lets through. Pure but for `homedir()`.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** pi's own set, from its utils/paths.js: these become a plain space in a tool path. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The absolute path pi's read, write and edit tools will actually touch, or
 * undefined when there is no such path. (read also tries a few spellings of a
 * name that does not exist — NFD, a curly apostrophe — which this does not.)
 *
 * A copy of pi's `resolveToCwd` (not exported from the package): an `@` prefix
 * is dropped, `~` is the home directory, and a `file://` URL is a path. A plain
 * `resolve(cwd, path)` gets all three wrong in the dangerous direction — it
 * reads `~/.zshrc` as `<cwd>/~/.zshrc`, inside the workspace, while the tool
 * writes the real one. `join`, not `resolve`, after the tilde, as pi does:
 * `~//work/x` is under the home directory, not `/work/x`.
 */
export function resolveToolPath(path: string, cwd: string): string | undefined {
	if (path.includes("\0")) return undefined;
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32") normalized = windowsShellPath(normalized);
	if (normalized === "~") return resolve(homedir());
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return resolve(join(homedir(), normalized.slice(2)));
	}
	if (normalized.startsWith("file://")) {
		try {
			return resolve(fileURLToPath(normalized));
		} catch {
			return undefined;
		}
	}
	return resolve(cwd, normalized);
}

/** pi's normalizeWindowsShellPath: `/c/x`, `/mnt/c/x` and `/cygdrive/c/x` are `C:\x`. */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
	if (!match) return path;
	return `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}
