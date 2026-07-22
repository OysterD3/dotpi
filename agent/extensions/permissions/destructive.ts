/**
 * Deciding whether a shell command is destructive.
 *
 * This is the part that makes "only ask me about destructive things" possible,
 * so it is deliberately deterministic: a readable table of patterns, no model
 * call in front of every command. That keeps it fast, offline, free, and — most
 * importantly for a security control — auditable. You can read PATTERNS below
 * and know exactly what will and will not prompt.
 *
 * Two things make it more than a regex list.
 *
 * First, commands are split into segments, so `echo ok && rm -rf /tmp/x` is
 * judged on the `rm`, not on the `echo`. Splitting respects quotes, so a
 * semicolon inside a string is not a separator.
 *
 * Second, command substitutions are pulled out and judged too, because
 * `$(rm -rf /)` runs. And a destructive-capable command whose arguments are
 * computed at runtime — `rm $(cat list)` — is treated as destructive precisely
 * because it cannot be read statically. Claude Code takes the same position:
 * an argument that is runtime-determined "could resolve to a dangerous action".
 *
 * Pure, so every rule below is directly testable.
 */

export type Finding = {
	/** Stable id, usable in an `allowDestructive` opt-out list. */
	id: string;
	/** Plain-language reason, shown in the approval prompt. */
	reason: string;
	/** The segment that triggered it. */
	segment: string;
};

type Pattern = {
	id: string;
	test: RegExp;
	reason: string;
};

/**
 * The catalogue. Edit this to taste — it is meant to be read and adjusted.
 *
 * Each entry is matched against a single command segment that has already been
 * split off from any chain, so patterns can assume they see one command.
 */
export const PATTERNS: Pattern[] = [
	// --- irreversible local destruction ---
	{ id: "rm-recursive", test: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b/, reason: "deletes files recursively or without confirmation" },
	{ id: "rm-glob", test: /\brm\s+[^|;&]*[*?]/, reason: "deletes files matched by a glob" },
	{ id: "shred", test: /\bshred\b/, reason: "irrecoverably overwrites file contents" },
	{ id: "truncate", test: /\btruncate\s+(-s|--size)\b/, reason: "truncates a file" },
	{ id: "dd", test: /\bdd\s+.*\bof=/, reason: "writes raw blocks to a device or file" },
	{ id: "mkfs", test: /\bmkfs(\.\w+)?\b/, reason: "formats a filesystem" },
	{ id: "disk-tools", test: /\b(fdisk|parted|diskutil\s+(erase|partition|reformat))\b/, reason: "repartitions or erases a disk" },
	{ id: "write-device", test: />\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b)/, reason: "writes directly to a device node" },

	// --- destroying uncommitted or published git work ---
	{ id: "git-reset-hard", test: /\bgit\s+(?:-\S+\s+)*reset\s+.*--hard\b/, reason: "discards uncommitted changes" },
	{ id: "git-clean", test: /\bgit\s+(?:-\S+\s+)*clean\b.*\s-[a-zA-Z]*[fdx]/, reason: "deletes untracked files" },
	{ id: "git-checkout-dot", test: /\bgit\s+(?:-\S+\s+)*(?:checkout|restore)\s+(?:--\s+)?\.(\s|$)/, reason: "discards uncommitted changes in the working tree" },
	{ id: "git-force-push", test: /\bgit\s+(?:-\S+\s+)*push\b.*(--force\b(?!-with-lease)|(?:^|\s)-f\b)/, reason: "force-pushes, overwriting published history" },
	{ id: "git-force-push-lease", test: /\bgit\s+(?:-\S+\s+)*push\b.*--force-with-lease\b/, reason: "force-pushes (with lease), rewriting published history" },
	{ id: "git-branch-delete", test: /\bgit\s+(?:-\S+\s+)*branch\b.*\s-[dD]\b/, reason: "deletes a branch" },
	{ id: "git-history-rewrite", test: /\bgit\s+(?:-\S+\s+)*(rebase|filter-branch|filter-repo)\b/, reason: "rewrites commit history" },
	{ id: "git-amend", test: /\bgit\s+(?:-\S+\s+)*commit\b.*--amend\b/, reason: "rewrites the last commit" },
	{ id: "git-stash-drop", test: /\bgit\s+(?:-\S+\s+)*stash\s+(drop|clear)\b/, reason: "discards stashed work" },
	{ id: "git-reflog-expire", test: /\bgit\s+(?:-\S+\s+)*(reflog\s+expire|gc\b.*--prune)/, reason: "expires the reflog, removing the recovery path" },
	{ id: "git-no-verify", test: /\bgit\b.*--no-verify\b/, reason: "skips hooks that would otherwise gate the commit or push" },

	// --- privilege and permissions ---
	{ id: "sudo", test: /(^|\s)(sudo|doas)\s/, reason: "runs with elevated privileges" },
	{ id: "su", test: /(^|\s)su\s+(-|\w)/, reason: "switches user" },
	{ id: "chmod-world", test: /\bchmod\b.*\b(777|666|a\+w|o\+w)\b/, reason: "makes files world-writable" },
	{ id: "chmod-recursive", test: /\b(chmod|chown|chgrp)\b.*\s(-R|--recursive)\b/, reason: "changes ownership or permissions recursively" },

	// --- running code fetched from the network ---
	{ id: "curl-pipe-shell", test: /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|da|fi)?sh\b/, reason: "pipes downloaded content straight into a shell" },
	{ id: "pipe-shell", test: /\|\s*(sudo\s+)?(ba|z|k|da|fi)?sh\b/, reason: "pipes output into a shell interpreter" },

	// --- publishing and deployment: outward-facing and hard to retract ---
	{ id: "package-publish", test: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b|\bpoetry\s+publish\b/, reason: "publishes a package to a public registry" },
	{ id: "docker-push", test: /\bdocker\s+push\b/, reason: "pushes an image to a registry" },
	{ id: "gh-release", test: /\bgh\s+(release\s+(create|upload|delete)|pr\s+merge|repo\s+delete)\b/, reason: "publishes or merges via GitHub" },
	{ id: "terraform-apply", test: /\bterraform\s+(apply|destroy)\b/, reason: "changes real infrastructure" },
	{ id: "kubectl-mutate", test: /\bkubectl\s+(delete|apply|drain|cordon|scale)\b/, reason: "changes cluster state" },
	{ id: "cloud-delete", test: /\baws\s+s3\s+(rm|rb)\b|\baws\s+s3\s+sync\b.*--delete\b|\bgcloud\s+\S+\s+delete\b|\baz\s+\S+\s+delete\b/, reason: "deletes cloud resources" },
	{ id: "deploy", test: /\b(vercel|netlify|flyctl|fly|heroku)\b.*\b(deploy|--prod|release)\b/, reason: "deploys to a hosted environment" },

	// --- databases ---
	{ id: "sql-drop", test: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE?)\b/i, reason: "drops or truncates database objects" },
	{ id: "sql-unbounded-delete", test: /\bDELETE\s+FROM\s+\S+\s*(;|$)/i, reason: "deletes every row (no WHERE clause)" },
	{ id: "sql-unbounded-update", test: /\bUPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/i, reason: "updates every row (no WHERE clause)" },
	{ id: "db-drop-cli", test: /\b(dropdb|mongo\S*\s+.*\bdrop\b)/, reason: "drops a database" },

	// --- processes and the machine ---
	{ id: "kill-force", test: /\b(kill\s+-9|kill\s+-KILL|killall|pkill)\b/, reason: "force-kills processes" },
	{ id: "power", test: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "shuts down or restarts the machine" },
	{ id: "fork-bomb", test: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: "is a fork bomb" },

	// --- history and credentials ---
	{ id: "history-clear", test: /\bhistory\s+-c\b|>\s*~?\/?\.?\w*_?history\b/, reason: "clears shell history" },
	{ id: "credential-write", test: /\b(security\s+add-generic-password|git\s+config\s+.*credential\.helper)\b/, reason: "writes credentials" },
];

/** Commands whose effect cannot be judged when their arguments are computed. */
const DYNAMIC_SENSITIVE = /\b(rm|mv|cp|chmod|chown|dd|kill|git|kubectl|aws|docker)\b/;

/** Command substitution: $(...) or `...`. */
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g;

/**
 * Split a command line into individually-judgeable segments.
 *
 * Separators are `;`, `&&`, `||`, `|`, and newlines, but only outside quotes —
 * otherwise `echo "a; b"` would be read as two commands and a `rm` inside a
 * quoted string would be judged as if it ran.
 */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | "`" | undefined;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}

		if (quote) {
			current += char;
			// Single quotes do not process escapes, so only the matching quote ends it.
			if (char === quote) quote = undefined;
			continue;
		}

		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			current += char;
			continue;
		}

		if (char === ";" || char === "\n") {
			segments.push(current);
			current = "";
			continue;
		}

		if ((char === "&" || char === "|") && command[i + 1] === char) {
			segments.push(current);
			current = "";
			i++;
			continue;
		}

		// A single `|` is deliberately NOT a separator: a pipeline is one logical
		// command, and `curl x | sh` is dangerous precisely as a combination.
		// Splitting it would leave `curl x` and `sh`, neither of which looks bad.
		current += char;
	}

	segments.push(current);
	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Pull out the bodies of any command substitutions, which also execute. */
export function substitutions(command: string): string[] {
	const found: string[] = [];
	for (const match of command.matchAll(SUBSTITUTION)) {
		const body = (match[1] ?? match[2] ?? "").trim();
		if (body.length > 0) found.push(body);
	}
	return found;
}

/** True when a segment's arguments are computed at runtime. */
function hasDynamicArguments(segment: string): boolean {
	return /\$\(|`|\$\{?\w/.test(segment);
}

/**
 * Commands that print or search text rather than execute it.
 *
 * For these, a quoted argument is inert: `echo "rm -rf /"` deletes nothing, and
 * `grep "rm -rf" .` is how you would look for the problem. Without this, using
 * the agent to search for dangerous patterns would prompt on every search.
 *
 * Deliberately short. `sh -c "..."`, `psql -c "DROP TABLE ..."` and friends are
 * absent because for them the quoted string IS the payload, and it must still be
 * judged.
 */
const INERT_COMMANDS = /^\s*(echo|printf|print|grep|rg|ag|ack)\b/;

/**
 * Blank the inside of quoted strings, preserving length and the quotes.
 *
 * Used only for inert commands, so a pattern cannot match text that is merely
 * being printed or searched for.
 */
export function blankQuoted(segment: string): string {
	let out = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of segment) {
		if (escaped) {
			out += quote ? " " : char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			out += char;
			escaped = true;
			continue;
		}
		if (quote) {
			out += char === quote ? char : " ";
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			out += char;
			continue;
		}
		out += char;
	}

	return out;
}

/**
 * Every reason this command is considered destructive. Empty means it is not.
 *
 * `allow` lists pattern ids to ignore, so a user who genuinely does not want to
 * be asked about, say, `git-amend` can silence exactly that one.
 */
export function findDestructive(command: string, allow: ReadonlySet<string> = new Set()): Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();

	const consider = (raw: string) => {
		// Judge inert commands on their unquoted parts only, but keep the original
		// text for display so the prompt shows what was actually requested.
		const segment = INERT_COMMANDS.test(raw) ? blankQuoted(raw) : raw;

		for (const pattern of PATTERNS) {
			if (allow.has(pattern.id)) continue;
			if (!pattern.test.test(segment)) continue;
			const key = `${pattern.id}::${raw}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({ id: pattern.id, reason: pattern.reason, segment: raw });
		}

		// A destructive-capable command whose targets are computed cannot be
		// cleared by reading it, so it is treated as destructive.
		if (!allow.has("dynamic-argument") && DYNAMIC_SENSITIVE.test(segment) && hasDynamicArguments(segment)) {
			const key = `dynamic-argument::${raw}`;
			if (!seen.has(key)) {
				seen.add(key);
				findings.push({
					id: "dynamic-argument",
					reason: "targets are computed at runtime, so what it affects cannot be checked in advance",
					segment: raw,
				});
			}
		}
	};

	for (const segment of splitSegments(command)) {
		consider(segment);
		// `$(rm -rf /)` runs even though the outer command looks harmless.
		for (const inner of substitutions(segment)) {
			for (const innerSegment of splitSegments(inner)) consider(innerSegment);
		}
	}

	return findings;
}

export function isDestructive(command: string, allow?: ReadonlySet<string>): boolean {
	return findDestructive(command, allow).length > 0;
}
