/**
 * Validating a directory before it joins the workspace.
 *
 * A direct port of Claude Code's `validateDirectoryForWorkspace` and its message
 * formatter, read out of the shipped binary (2.1.217). The result *types* are the
 * interesting part: the difference between "you named a file" and "that path does
 * not exist" and "that is already covered by a directory you added earlier" is
 * three different pieces of advice, and collapsing them into one "invalid path"
 * makes the command annoying to use.
 *
 * One case is added that Claude Code has no need for: `limitReached`. Claude Code
 * uses the workspace as a permission boundary, so a long list costs nothing. Here
 * every directory contributes to the system prompt each turn, so the list is
 * capped.
 */

import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONFIG } from "./config.ts";
import { expandPath, isWithin } from "./paths.ts";

export type ValidationResult =
	| { resultType: "emptyPath" }
	| { resultType: "pathNotFound"; directoryPath: string; absolutePath: string }
	| { resultType: "notADirectory"; directoryPath: string; absolutePath: string }
	| {
			resultType: "alreadyInWorkingDirectory";
			directoryPath: string;
			workingDir: string;
			isExactMatch: boolean;
			isOriginalCwd: boolean;
	  }
	| { resultType: "limitReached"; directoryPath: string; absolutePath: string; limit: number }
	| { resultType: "success"; absolutePath: string };

export type ValidateOptions = {
	/** Every directory currently in the workspace, cwd first. */
	workingDirs: string[];
	/** The session's own cwd, so "already there" can say which kind. */
	cwd: string;
	/** How many are already additional, for the cap. */
	additionalCount: number;
};

export async function validateDirectory(
	input: string,
	{ workingDirs, cwd, additionalCount }: ValidateOptions,
): Promise<ValidationResult> {
	if (!input) return { resultType: "emptyPath" };

	let absolutePath: string;
	try {
		absolutePath = resolve(expandPath(input, cwd));
	} catch {
		return { resultType: "pathNotFound", directoryPath: input, absolutePath: input };
	}

	try {
		if (!(await stat(absolutePath)).isDirectory()) {
			return { resultType: "notADirectory", directoryPath: input, absolutePath };
		}
	} catch {
		// Any stat failure means we cannot use it: missing, unreadable, or a
		// dangling symlink all land here and all mean the same thing to the user.
		return { resultType: "pathNotFound", directoryPath: input, absolutePath };
	}

	for (const workingDir of workingDirs) {
		if (isWithin(absolutePath, workingDir)) {
			return {
				resultType: "alreadyInWorkingDirectory",
				directoryPath: input,
				workingDir,
				isExactMatch: resolve(workingDir) === absolutePath,
				isOriginalCwd: workingDir === cwd,
			};
		}
	}

	if (additionalCount >= CONFIG.maxDirectories) {
		return {
			resultType: "limitReached",
			directoryPath: input,
			absolutePath,
			limit: CONFIG.maxDirectories,
		};
	}

	return { resultType: "success", absolutePath };
}

/** Claude Code's wording, minus its bold markup. */
export function describe(result: ValidationResult): string {
	switch (result.resultType) {
		case "emptyPath":
			return "Please provide a directory path.";
		case "pathNotFound":
			return `Path ${result.absolutePath} was not found.`;
		case "notADirectory":
			return `${result.directoryPath} is not a directory. Did you mean to add the parent directory ${dirname(result.absolutePath)}?`;
		case "alreadyInWorkingDirectory": {
			if (result.isExactMatch) {
				return result.isOriginalCwd
					? `${result.directoryPath} is already the current working directory.`
					: `${result.directoryPath} is already added as a working directory.`;
			}
			const kind = result.isOriginalCwd ? "the current working directory" : "the additional working directory";
			return `${result.directoryPath} is already accessible within ${kind} ${result.workingDir}.`;
		}
		case "limitReached":
			return `Already at the limit of ${result.limit} additional working directories. Remove one with /dirs first.`;
		case "success":
			return `Added ${result.absolutePath} as a working directory.`;
	}
}
