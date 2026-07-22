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
 *
 * ## Where this table comes from
 *
 * Originally: written from scratch, not derived from anything. It was then
 * audited (2026-07) against the shipped Claude Code binary, which turned out to
 * contain three distinct things worth separating:
 *
 *   1. An enumerated destructive regex table (`q2g`, 16 Bash entries) that never
 *      blocks. Its only consumers are an advisory "Note: may …" string behind a
 *      default-off flag, a telemetry field, and a decision to attach `git status`
 *      output. Its ids — git_reset_hard, git_force_push, git_clean_force,
 *      rm_recursive_force, sql_drop_truncate, kubectl_delete, terraform_destroy —
 *      map almost one-to-one onto entries here, which is reassuring but was
 *      arrived at independently.
 *   2. Narrow deterministic *blocking*, and only for `rm` path shape: filesystem
 *      root, a drive root, `$HOME`, a direct child of `/`, a workspace ancestor,
 *      an unresolvable glob, an empty variable expansion. Not implemented here
 *      yet — see the note on `rm-recursive`.
 *   3. A 66-rule taxonomy (1 hard: data_exfiltration; 65 soft) that is a *prompt*
 *      for an LLM classifier, and whose own text says "RULE LISTS ARE EXAMPLES,
 *      NOT BOUNDARIES".
 *
 * So there was no denylist to copy: Claude Code gates deterministically with an
 * allowlist and defers everything else to a model. The 66 rule names were used as
 * a coverage checklist, and the entries marked `[added after the 2026-07 audit]`
 * came from that pass — each one adversarially reviewed for false positives
 * against ordinary development commands before being accepted.
 *
 * A corpus test guards this: 171 ordinary commands must produce zero findings,
 * 85 dangerous ones must all be caught. Add to both lists when you edit here.
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
	{ id: "rm-recursive", test: /\brm\s+(?:[^|;&]*\s)?(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force|--no-preserve-root)(?=\s|$)/, reason: "deletes files recursively or without confirmation" },
	{ id: "rm-glob", test: /\brm\s+[^|;&]*[*?]/, reason: "deletes files matched by a glob" },
	{ id: "shred", test: /\bshred\b/, reason: "irrecoverably overwrites file contents" },
	{ id: "truncate", test: /\btruncate\s+(-s|--size)\b/, reason: "truncates a file" },
	{ id: "dd", test: /\bdd\s+.*\bof=/, reason: "writes raw blocks to a device or file" },
	{ id: "mkfs", test: /\bmkfs(\.\w+)?\b/, reason: "formats a filesystem" },
	{ id: "disk-tools", test: /\b(?:fdisk|parted|sgdisk|wipefs|blkdiscard|diskutil\s+(?:erase|partition|reformat|zero)\w*)\b/, reason: "repartitions or erases a disk" },
	{ id: "write-device", test: />\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b)/, reason: "writes directly to a device node" },

	// --- destroying uncommitted or published git work ---
	{ id: "git-reset-hard", test: /\bgit\s+(?:-\S+\s+)*reset\s+.*--hard\b/, reason: "discards uncommitted changes" },
	{ id: "git-clean", test: /\bgit\s+(?:-\S+\s+)*clean\b.*\s-[a-zA-Z]*[fdx]/, reason: "deletes untracked files" },
	{ id: "git-checkout-dot", test: /\bgit\s+(?:-\S+\s+)*(?:restore(?![^|;&]*\s--staged\b(?![^|;&]*\s--worktree\b))|checkout\b[^|;&]*(?:(?:^|\s)--\s|(?:^|\s)-f\b|(?:^|\s)--force\b|(?:^|\s)\.(?:\s|$)))/, reason: "discards uncommitted changes in the working tree" },
	{ id: "git-force-push", test: /\bgit\s+(?:-\S+\s+)*push\b[^|;&]*(?:--force(?!-with-lease)|\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|\s\+[\w.\/-]+:)/, reason: "force-pushes, overwriting published history" },
	{ id: "git-force-push-lease", test: /\bgit\s+(?:-\S+\s+)*push\b.*--force-with-lease\b/, reason: "force-pushes (with lease), rewriting published history" },
	{ id: "git-branch-delete", test: /\bgit\s+(?:-\S+\s+)*branch\s+(?:[^|;&\s]+\s+)*(-[a-zA-Z]*[dD]\b|--delete\b)/, reason: "deletes a branch" },
	{ id: "git-history-rewrite", test: /\bgit\s+(?:-\S+\s+)*(?:rebase|filter-branch|filter-repo)\b(?![^|;&]*\s--(?:abort|continue|skip|quit|edit-todo)\b)/, reason: "rewrites commit history" },
	{ id: "git-amend", test: /\bgit\s+(?:-\S+\s+)*commit\b.*--amend\b/, reason: "rewrites the last commit" },
	{ id: "git-stash-drop", test: /\bgit\s+(?:-\S+\s+)*stash\s+(drop|clear)\b/, reason: "discards stashed work" },
	{ id: "git-reflog-expire", test: /\bgit\s+(?:-\S+\s+)*(reflog\s+expire|gc\b.*--prune)/, reason: "expires the reflog, removing the recovery path" },
	{ id: "git-no-verify", test: /\bgit\b.*--no-verify\b/, reason: "skips hooks that would otherwise gate the commit or push" },

	// --- privilege and permissions ---
	{ id: "sudo", test: /(^|\s)(?:sudo|doas|pkexec|runuser)\s/, reason: "runs with elevated privileges" },
	{ id: "su", test: /(^|\s)su\s+(-|\w)/, reason: "switches user" },
	{ id: "chmod-world", test: /\bchmod\b[^|;&]*(?:\s0?[0-7][0-7][2367]\b|\s[ugoa]*[oa][ugoa]*[+=][rwxst]*w)/, reason: "makes files world-writable" },
	{ id: "chmod-recursive", test: /\b(chmod|chown|chgrp)\b.*\s(-R|--recursive)\b/, reason: "changes ownership or permissions recursively" },

	// --- running code fetched from the network ---
	{ id: "curl-pipe-shell", test: /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo(\s+-\S+)*\s+)?(env\s+\S+=\S+\s+)*(ba|z|k|da|fi)?sh\b/, reason: "pipes downloaded content straight into a shell" },
	{ id: "pipe-shell", test: /\|\s*(?:(?:sudo|doas|command|env|nohup|time|xargs|stdbuf)\s+(?:-\S+\s+|\S+=\S+\s+|\{\}\s+)*)*(?:ba|z|k|da|fi)?sh\b/, reason: "pipes output into a shell interpreter" },

	// --- publishing and deployment: outward-facing and hard to retract ---
	{ id: "package-publish", test: /\b(npm|pnpm|yarn|bun)\s+(publish|dist-tag\s+add|unpublish|deprecate)\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b|\bpoetry\s+publish\b|\bmvn\b[^|;&]*\bdeploy\b|\bgradle\S*\s[^|;&]*\bpublish\b|\bdotnet\s+nuget\s+push\b|\bflit\s+publish\b/, reason: "publishes a package to a public registry" },
	{ id: "docker-push", test: /\b(docker|podman|nerdctl)\s+(image\s+)?push\b|\b(docker|podman|nerdctl)\s+buildx?\s[^|;&]*--push\b|\bskopeo\s+copy\b|\bhelm\s+push\b/, reason: "pushes an image to a registry" },
	{ id: "gh-release", test: /\bgh\s+(release\s+(create|upload|delete)|pr\s+merge|repo\s+delete)\b/, reason: "publishes or merges via GitHub" },
	{ id: "terraform-apply", test: /\bterraform\s+(?:-\S+\s+)*(apply|destroy)\b/, reason: "changes real infrastructure" },
	{ id: "kubectl-mutate", test: /\b(kubectl|oc)\s+(?:--?\S+(?:[= ]\S+)?\s+)*(delete|apply|create|replace|patch|edit|scale|drain|cordon|uncordon|taint|rollout|set|annotate|label|exec|cp|port-forward|attach|expose|run)\b/, reason: "changes cluster state" },
	{ id: "cloud-delete", test: /\baws\s+s3\s+(rm|rb)\b|\baws\s+s3(api)?\s+\S*sync\b[^|;&]*--delete\b|\baws\s+\S+\s+(delete|terminate|destroy|purge|deregister|remove)-\S+|\b(gcloud|az)\s+(?:[\w-]+\s+){1,4}delete\b/, reason: "deletes cloud resources" },
	{ id: "deploy", test: /\b(vercel|netlify|flyctl|fly|heroku)\b.*\b(deploy|--prod|release)\b/, reason: "deploys to a hosted environment" },

	// --- databases ---
	{ id: "sql-drop", test: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|FUNCTION|ROLE|USER|EXTENSION)|TRUNCATE\s+(TABLE\s+)?["`\[]?\w)/i, reason: "drops or truncates database objects" },
	{ id: "sql-unbounded-delete", test: /\bDELETE\s+FROM\s+[^\s;'"]+\s*(?=$|[;'"])/i, reason: "deletes every row (no WHERE clause)" },
	{ id: "sql-unbounded-update", test: /\bUPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/i, reason: "updates every row (no WHERE clause)" },
	{ id: "db-drop-cli", test: /\b(dropdb|mongo\S*\s+.*\bdrop\b)/, reason: "drops a database" },

	// --- processes and the machine ---
	{ id: "kill-force", test: /\b(kill\s+-9|kill\s+-KILL|killall|pkill)\b/, reason: "force-kills processes" },
	{ id: "power", test: /^\s*(?:(?:sudo|doas)\s+)?(?:systemctl\s+)?(?:shutdown|reboot|halt|poweroff)\b/, reason: "shuts down or restarts the machine" },
	{ id: "fork-bomb", test: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: "is a fork bomb" },

	// --- history and credentials ---
	{ id: "history-clear", test: /\bhistory\s+-c\b|>\s*~?\/?\.?\w*_?history\b/, reason: "clears shell history" },
	{ id: "credential-write", test: /\b(security\s+add-generic-password|git\s+config\s+.*credential\.helper)\b/, reason: "writes credentials" },

	// --- irreversible local destruction ---  [added after the 2026-07 audit]
	{ id: "find-delete", test: /\bfind\b[^|;&]*\s-(?:delete(?=\s|$)|(?:exec|execdir|ok|okdir)\s+(?:sudo\s+)?(?:\S*\/)?(?:rm|rmdir|unlink)(?=\s|$))/, reason: "deletes every file matched by find" },
	{ id: "rsync-delete", test: /\brsync\b(?![^|;&]*(?:\s--(?:dry-run|list-only)\b|\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)))[^|;&]*\s--del(?:ete(?:-[a-z]+)*)?(?=\s|$)/, reason: "deletes files in the destination that are absent from the source" },
	{ id: "inplace-edit-bulk", test: /(?:\bxargs\s+(?:-\S+\s+)*|-exec\s+)(?:\S*\/)?g?(?:sed|perl|ruby)\s+(?:-\S+\s+)*(?:-[a-zA-Z0-9]*i(?:\.\S*)?(?![a-zA-Z])|--in-place)|(?:^|[|;&]\s*)(?:\S*\/)?g?(?:sed|perl|ruby)\s+(?:-\S+\s+)*(?:-[a-zA-Z0-9]*i(?:\.\S*)?(?![a-zA-Z])|--in-place)[^|;&]*\s[^\s'"|;&]*[*?][^\s'"|;&]*(?=\s|$)/, reason: "rewrites many files in place, with no backup and no diff to review" },
	{ id: "interpreter-inline-destroy", test: /(?:^|\|\s*)\s*(?:[\w.\/-]*\/)?(?:python[23]?(?:\.\d+)?\s+(?:-[A-Za-z]+\s+){0,6}-[A-Za-z]*c\b|(?:node|bun|deno)\s+(?:-[A-Za-z][\w-]*(?:=\S+)?\s+){0,6}(?:-e|--eval)\b|(?:ruby|perl)\s+(?:-[A-Za-z]\S*\s+){0,6}-[eE]\b|php\s+(?:-[A-Za-z]\S*\s+){0,6}-r\b)[\s\S]*(?:shutil\.rmtree\s*\(|\bos\.(?:remove|unlink|removedirs|rmdir)\s*\(|\.unlink\s*\(|\bfs\.rm\s*\(|\brm(?:Sync|dirSync)\s*\(|\bunlinkSync\s*\(|\bFileUtils\.rm_rf\b|\bFile\.delete\s*\(|\bunlink\s*\(|\bunlink\s+(?:glob\b|[$@"'\/])|\.truncate\s*\()/, reason: "deletes files through an inline interpreter script" },

	// --- destroying uncommitted or published git work ---  [added after the 2026-07 audit]
	{ id: "git-push-delete", test: /\bgit\s+(?:-\S+\s+)*push\b[^|;&]*[\s"'](?:--delete|-d|--mirror|--prune|:[A-Za-z0-9._\/-]+)(?=[\s"']|$)/, reason: "deletes remote branches, tags, or refs" },
	{ id: "git-worktree-remove", test: /\bgit\s+(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|exec-path))\s+\S+\s+|-\S+\s+)*worktree\s+remove\b[^|;&]*\s(?:-f+|--force)(?=\s|$)/, reason: "deletes a worktree along with its uncommitted changes" },

	// --- local service data ---  [added after the 2026-07 audit]
	{ id: "docker-volume-destroy", test: /\bdocker(?:\s+compose|-compose)?(?:\s+-{1,2}[\w.-]+(?:=\S+)?(?:\s+[^-\s][^\s|;&]*)?)*\s+(?:volume\s+(?:rm|prune)\b|system\s+prune\b[^|;&]*\s--volumes\b|down\b[^|;&]*\s(?:-v\b|--volumes\b))/, reason: "deletes docker volumes, destroying local database and service data" },
	{ id: "db-reset-tool", test: /\b(?:prisma\s+migrate\s+reset\b|(?:rails|rake)\s+db:(?:drop|reset)\b|manage\.py\s+(?:flush|reset_db)\b|supabase\s+db\s+reset\b|alembic\s+downgrade\s+base\b|sequelize\s+db:drop\b)|(?:^|\s)(?:\S+\/)?flyway(?=[\s,])[^|;&]*[\s,]clean\b/, reason: "drops and recreates the database, discarding all its data" },
	{ id: "redis-flush", test: /\bredis-cli\b[^|;&]*\s(?<!\b(?:docs|info|help|getkeys)\s)(?:flushall|flushdb)\b/i, reason: "erases every key in the redis instance" },

	// --- running code fetched from the network ---  [added after the 2026-07 audit]
	{ id: "pipe-interpreter", test: /\b(?:curl|wget|fetch|base64)\b[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:python(?:[23](?:\.\d+)?)?|node|deno|ruby|perl|php|bun)(?:\s+-[a-zA-Z]*)*\s*(?:\d?>>?\s*\S+\s*)*(?:$|\|)/, reason: "pipes downloaded or decoded content into a language interpreter as its program" },
	{ id: "shell-process-substitution", test: /^\s*(?:(?:sudo|doas)\s+)?(?:\S*\/)?(?:(?:ba|z|k|da|fi)?sh|source|eval|exec|\.)\s+(?:-\S+\s+)*<\s*(?:<\s*)?\(\s*[^)]*(?:\b(?:curl|wget|fetch|aria2c)\b|https?:\/\/)/, reason: "runs a shell on the output of a process substitution" },
	{ id: "eval-dynamic", test: /^eval\s+[^;&|]*(?:\$\(|`)[^)`]*\b(?:curl|wget|fetch)\s/, reason: "evaluates runtime-computed text as shell code" },

	// --- publishing, deployment and infrastructure ---  [added after the 2026-07 audit]
	{ id: "paas-deploy", test: /^\s*(?!.*\s(?:--dry-run|--no-execute-changeset|--syntax-check|--check|--list-tasks|--list-hosts|--list-tags|--version|--help|--local)\b)(?:\w+=\S*\s+|(?:npx|pnpx|bunx|yarn|time|env)\s+|(?:pnpm|npm|bun)\s+(?:dlx|exec|run)\s+|--\s+)*(?:wrangler\s+(?:(?:pages|versions)\s+)?(?:deploy|publish)\b|firebase\s+deploy\b|gcloud\s+(?:run|app|functions)\s+deploy\b|aws\s+(?:lambda\s+update-function-code\b|cloudformation\s+(?:deploy|delete-stack)\b|apprunner\s+start-deployment\b)|(?:sls|serverless)\s+deploy\b|sam\s+deploy\b|eb\s+deploy\b|supabase\s+(?:db\s+push|functions\s+deploy)\b|ansible-playbook\s+\S)/, reason: "deploys code to a hosted environment" },
	{ id: "iac-apply", test: /^(?:\w+=\S+\s+)*(?:(?:sudo|npx|bunx|pnpm|yarn|time|do|then|exec|xargs)\s+)*(?:helm\s+(?:install|upgrade|uninstall|delete|rollback)\b(?![^|;&]*--dry-run\b)|pulumi\s+(?:up|destroy|stack\s+rm)\b|cdk\s+(?:deploy|destroy)\b|terragrunt\s+(?:run-all\s+|run\s+|--all\s+)*(?:apply|destroy)\b|terraform\s+(?:-\S+\s+)*(?:state\s+(?:rm|push)|workspace\s+delete)\b)/, reason: "applies or destroys infrastructure outside terraform" },
	{ id: "gh-publish-mutate", test: /\bgh\s+(gist\s+(create|edit)\b|repo\s+create\b[^|;&]*--(public|internal)\b|repo\s+edit\b[^|;&]*--visibility[=\s]+(public|internal)\b|api\b[^|;&]*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b|issue\s+delete\b)/, reason: "publishes or mutates state on GitHub" },

	// --- reaching other machines, or letting them reach yours ---  [added after the 2026-07 audit]
	{ id: "remote-shell-copy", test: /(?:^|\|)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:scp|rsync|sftp)\b[^|;&]*\s[\w.-]+@[\w.-]+:|(?:^|\|)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?ssh\s+(?:-[BbcDEeFIiJLlmOopQRSWw]\s+\S+\s+|-(?![BbcDEeFIiJLlmOopQRSWw]\s)\S+\s+)*[\w.@$][\w.@$-]*\s+[^\s-]/, reason: "copies files to or runs a command on a remote host" },
	{ id: "tunnel-expose", test: /\bngrok\s+(http|tcp|tls|start)\b|\bcloudflared\s+tunnel\s+(run\b|--url\b)|^\s*(npx\s+)?localtunnel\b|\btailscale\s+funnel\s+(?!(status|off|reset)\b)\S|\bbore\s+local\b|^\s*(\.\/)?frpc\b(?!\.)|\bchisel\s+(client|server)\b|^\s*ssh\s(?:[^|]*\s)?-R\s*\S*\d+:/, reason: "exposes a local service to the public internet" },
	{ id: "git-remote-repoint", test: /\bgit\s+(?:-[cC]\s+\S+\s+|-\S+\s+)*remote\s+set-url\b|\bgit\s+config\s+(?:--(?!get)\S+\s+)*(?:set\s+)?remote\.[\w.-]+\.(?:url|pushurl)\s+[^\s|&><]/, reason: "changes where git pushes go" },
	{ id: "dns-cert-change", test: /\b(aws\s+route53\s+(change-resource-record-sets|delete-hosted-zone)|aws\s+route53domains\s+(update-domain-nameservers|transfer-domain|disable-domain-transfer-lock)|gcloud\s+dns\s+(record-sets|managed-zones)\s+(update|delete)\b|gcloud\s+dns\s+record-sets\s+transaction\s+execute\b|az\s+network\s+dns\s+(record-set\s+\S+|zone)\s+(update|delete|remove-record)\b|aws\s+acm\s+delete-certificate\b|certbot\s+(?!.*--dry-run)(certonly|run|delete|revoke|renew|--nginx|--apache|--standalone|-d\s)|acme\.sh\s+(?!.*--staging)(--issue|--renew|--deploy|--install-cert|--revoke|--remove)\b)/, reason: "changes DNS records or TLS certificates" },

	// --- credentials and persistence ---  [added after the 2026-07 audit]
	{ id: "secret-store-write", test: /\b(gh\s+secret\s+(set|delete)|vault\s+(kv\s+(put|patch|delete|destroy)|delete)|aws\s+secretsmanager\s+(delete-secret|put-secret-value|rotate-secret)|aws\s+ssm\s+delete-parameters?|gcloud\s+secrets\s+versions\s+(destroy|disable)|az\s+keyvault\s+secret\s+(set|delete|purge)|kubectl\s+create\s+secret\b(?![^|;&]*--dry-run)|wrangler\s+secret\s+(put|delete|bulk)|(fly|flyctl)\s+secrets\s+(set|unset|import)|heroku\s+config:(set|unset)|doppler\s+secrets\s+(set|delete))\b/, reason: "creates, rotates, or deletes an entry in a secret store" },
	{ id: "startup-file-write", test: /(?:(?<![-=<>])>>?|\btee\b(?:\s+-\S+)*\s)\s*['"]?(?:[^\s'"|;&]*\/)?(?:\.(?:bashrc|bash_profile|bash_login|zshrc|zshenv|zprofile|profile|kshrc|netrc|npmrc)|authorized_keys|config\.fish|credentials)(?=['"]?(?:\s|$))/, reason: "writes to a shell startup file or credential store" },
];

/**
 * Commands whose effect cannot be judged when their arguments are computed.
 *
 * Scoped to the destructive *subcommands*, not the whole tool. Matching bare
 * `git` and `docker` meant `git log --oneline $BASE..HEAD`, `git commit -m "$MSG"`
 * and `docker logs $ID` were all reported destructive — constant, obviously-safe
 * commands, and exactly the cry-wolf that gets a detector switched off.
 */
const DYNAMIC_SENSITIVE =
	/\b(?:rm|rmdir|mv|cp|dd|shred|truncate|chmod|chown|chgrp|kill|pkill|killall)\b|\bgit\s+(?:-\S+\s+)*(?:push|reset|clean|checkout|restore|branch|rebase|tag|worktree|filter-\w+|update-ref)\b|\b(?:kubectl|oc)\s+(?:--?\S+(?:[= ]\S+)?\s+)*(?:delete|apply|patch|scale|replace|exec)\b|\baws\s+\S+\s+(?:rm|rb|delete\S*|terminate\S*)\b|\bdocker\s+(?:rm|rmi|push|prune|system|volume)\b/;

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
 * Commands whose quoted arguments are text, not code.
 *
 * `echo "rm -rf /"` deletes nothing, `grep "rm -rf" .` is how you would look for
 * the problem, and `git commit -m "fix rm -rf handling"` is a commit message.
 * Without this, using the agent to search for or describe a dangerous command
 * would prompt every time — and the commit-message case fired constantly, since
 * describing what you just fixed is most of what commit messages are.
 *
 * Command substitutions are still judged: they are extracted from the raw
 * segment before any blanking, so `git commit -m "$(rm -rf /)"` is caught.
 *
 * Deliberately short. `sh -c "..."`, `psql -c "DROP TABLE ..."` and friends are
 * absent because for them the quoted string IS the payload, and it must still be
 * judged.
 */
const INERT_COMMANDS =
	/^\s*(?:echo|printf|print|grep|rg|ag|ack)\b|^\s*git\s+(?:-\S+\s+)*(?:commit|tag|notes|merge|revert|cherry-pick)\b|^\s*gh\s+(?:pr|issue|release|gist)\s+\w+/;

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
