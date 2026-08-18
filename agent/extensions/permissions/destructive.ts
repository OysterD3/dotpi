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
 * because it cannot be read statically: an argument that is runtime-determined
 * could resolve to a dangerous action.
 *
 * Pure, so every rule below is directly testable.
 *
 * ## Where this table comes from
 *
 * Originally: written from scratch, not derived from anything. It was then
 * audited (2026-07) against a comparable agent's shipped implementation, which
 * turned out to contain three distinct things worth separating:
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
 * So there was no denylist to copy: that one gates deterministically with an
 * allowlist and defers everything else to a model. The 66 rule names were used as
 * a coverage checklist, and the entries marked `[added after the 2026-07 audit]`
 * came from that pass — each one adversarially reviewed for false positives
 * against ordinary development commands before being accepted.
 *
 * A corpus test guards this: 188 ordinary commands must produce zero findings,
 * 138 dangerous ones must all be caught. Add to both lists when you edit here.
 *
 * ## The hard tier
 *
 * Almost everything here produces a prompt. A pattern marked `hard` produces a
 * refusal instead — see the field's own comment for the bar it has to clear and
 * for the four bypass routes that had to be closed to make the word mean
 * anything. Two patterns carry it, both about putting a local service on the
 * public internet.
 */

export type Finding = {
	/** Stable id, usable in an `allowDestructive` opt-out list. */
	id: string;
	/** Plain-language reason, shown in the approval prompt. */
	reason: string;
	/**
	 * Short noun phrase naming the CLASS, for the "allow all of these" menu
	 * option. Optional: nearly every reason is a verb phrase that already reads
	 * correctly after "Allow anything that …", so only the ones that do not need
	 * this. See the option builder in index.ts for what goes wrong without it.
	 */
	label?: string;
	/** The segment that triggered it. */
	segment: string;
	/**
	 * A finding that blocks outright instead of prompting. See `Pattern.hard`.
	 * Read by decide(), which turns it into `deny` rather than `ask`.
	 */
	hard?: true;
};

type Pattern = {
	id: string;
	test: RegExp;
	reason: string;
	/**
	 * Not a prompt — a refusal.
	 *
	 * Every other pattern here asks, because "destructive" is a judgement about
	 * risk and the person at the keyboard may have a reason. A hard pattern is a
	 * standing decision that no reason is good enough, taken once, in code, so
	 * that it cannot be taken again per-command at the moment it is least likely
	 * to be considered carefully.
	 *
	 * That only means something if every route around it is closed, so all four
	 * are: `allowDestructive` cannot suppress it (checked below), a session grant
	 * cannot lift it (index.ts consults grants only after a deny), the prompt is
	 * never shown so there is nothing to approve, and it runs in `allowAll` too
	 * (decide()), because otherwise the block would be one mode switch deep.
	 *
	 * The bar for adding one: exposure that outlives the command and cannot be
	 * undone by the person who approved it. A public tunnel is the case — once a
	 * URL is live and indexed, "deny" a minute later does not close it.
	 */
	hard?: true;
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
	// Reading one was the gap. Every other secret pattern here is a WRITE, and
	// `permissions.deny` covers `Read(**/.env)` — the read TOOL, not bash — so
	// `cat .env` matched nothing at all. It is the half that cannot be undone: a
	// printed secret is in the transcript, the session file, and the provider's
	// logs before anyone can react.
	//
	// What this buys, stated exactly, because it is less than it looks: in `auto`
	// the finding does not block — it routes to the classifier like every other
	// soft finding, and the model still decides. What changes is that the model
	// is now TOLD the table flagged a credential read instead of rediscovering it
	// from the raw string, the prompting modes ask deterministically, and a
	// classifier outage falls back to a prompt rather than to allow. The verdict
	// still rests on the model in the mode this repo actually runs.
	// `.envrc` is direnv and routinely holds exported secrets; `.env` takes any
	// number of suffixes (`.env.production.local`), so the excluded template
	// names are checked across the whole run rather than one component.
	{ id: "secret-file-read", test: /\b(?:cat|bat|less|more|head|tail|strings|xxd|od|base64|nl)\b[^|;&]*?(?:\.envrc|\.env(?![\w.-]*\.(?:example|sample|template|dist|schema)\b)(?:\.[\w-]+)*|\.aws\/credentials|\.ssh\/id_\w+|\.netrc|\.pgpass|\.pypirc|\S+\.(?:pem|p12|pfx|key))(?=['"\s]|$)/, reason: "reads a credential file" },
	// The secret word must END the variable name. `$GITHUB_TOKEN` is the token;
	// `$SERVICE_TOKEN_NAME` is the name OF one and prints nothing secret.
	// `$AWS_SECRET_ACCESS_KEY` still matches — on its ACCESS_KEY tail.
	{ id: "secret-env-print", test: /\b(?:printenv\s+\S*|echo\s+[^|;&]*\$\{?)\w*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY)(?![\w])/i, reason: "prints a credential held in an environment variable" },

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
	// `npx` was one spelling of a package runner among many, and the tunnel rode
	// in on every other one: pnpx, tnpx, bunx, `pnpm dlx`, `yarn dlx`, `npm exec`.
	// `lt` is localtunnel's real binary name and needs a port or subdomain flag
	// to match, being two letters. The runner prefix is optional, so an installed
	// binary invoked directly is caught too.
	{ id: "tunnel-expose", test: /\bngrok\s+(http|tcp|tls|start)\b|\bcloudflared\s+tunnel\s+(run\b|--url\b)|^\s*(?:(?:sudo|doas|env|nohup|time|command|exec|setsid|stdbuf|xargs)\s+(?:-\S+\s+)*|\w+=\S+\s+)*(?:(?:npx|pnpx|tnpx|bunx)\s+(?:-\S+\s+)*|(?:npm|pnpm|yarn|bun)\s+(?:dlx|exec|x)\s+(?:-\S+\s+)*)?(?:localtunnel\b|lt\s+[^|;&]*(?:-p\b|--port\b|-s\b|--subdomain\b|-h\b|--host\b))|\btailscale\s+funnel\s+(?!(status|off|reset)\b)\S|\bbore\s+local\b|\bzrok\s+share\b|^\s*(?:(?:sudo|doas|env|nohup|time|command|exec|setsid|stdbuf|xargs)\s+(?:-\S+\s+)*|\w+=\S+\s+)*(\.\/)?pinggy\b|\btelebit\s+(http|https|tcp)\b|^\s*(?:(?:sudo|doas|env|nohup|time|command|exec|setsid|stdbuf|xargs)\s+(?:-\S+\s+)*|\w+=\S+\s+)*(\.\/)?frp[cs]\b(?!\.)|\bdocker\s+(?:run|create)\b[^|;&]*\bfrp[cs]\b|\bdocker\s+compose\s+up\b[^|;&]*\bfrp[cs]\b|^\s*(?:(?:sudo|doas|env|nohup|time|command|exec|setsid|stdbuf|xargs)\s+(?:-\S+\s+)*|\w+=\S+\s+)*(\.\/)?(?:cpolar|natapp|phddns)\b|\bchisel\s+(client|server)\b|^\s*(?:(?:sudo|doas|env|nohup|time|command|exec|setsid|stdbuf|xargs)\s+(?:-\S+\s+)*|\w+=\S+\s+)*ssh\s(?:[^|]*\s)?-R\s*\S*\d+:/, reason: "exposes a local service to the public internet", hard: true },
	// Gradio and the UIs built on it put a local app on a public gradio.live URL
	// from a keyword argument, with no tunnel binary anywhere in the command —
	// which is why the rule above cannot see it. `--share` is the same switch
	// spelled as a flag, as stable-diffusion-webui and its forks take it.
	// `--no-share` does not match: the literal needs a boundary before it.
	{ id: "public-share", test: /\bshare\s*=\s*True\b|\bgradio\s+deploy\b/, reason: "publishes a local app on a public URL", hard: true },
	// A bare `--share` is the same switch on the Stable Diffusion forks, but it
	// is also just a common flag name — `npm run build -- --share` is somebody
	// else's CLI. It prompts rather than refusing, because a refusal here has no
	// override and would leave that project with no way to run its own build.
	{ id: "share-flag", test: /(?:^|\s)--share(?:=(?:1|true|True))?(?=\s|$)/, reason: "may publish a local app on a public URL" },
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
 *
 * Narrowed a second time, for the same reason one scope out. The subcommand
 * fix stopped `git log $BASE..HEAD` but left `git checkout "$BRANCH"`,
 * `cp "$f" build/`, `mv "$a" "$b"` and `kill $PID` all reported destructive on
 * the strength of a `$` — everyday commands, prompting every time, which is
 * the complaint that started this. Under the three-category policy the
 * question is not "could this be surprising" but "could the computed value
 * make this a SYSTEM-WIDE deletion", and only the file-destroying primitives
 * can. A computed branch name cannot exfiltrate anything, a computed PID
 * cannot expose a secret, and a computed path handed to `cp` writes rather
 * than erases.
 *
 * What is given up: `rm $target` where the value turns out to be `/`. Note
 * `rm-recursive` still catches every `rm -rf` on its own, computed or not, so
 * what actually loses deterministic cover is a NON-recursive `rm`, plus `dd`
 * and `shred` — all three still listed below. The classifier sees the raw
 * text either way and the policy tells it a recursive delete reaching outside
 * the working directories is category (3).
 */
const DYNAMIC_SENSITIVE = /\b(?:rm|rmdir|dd|shred)\b/;

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
	// A double-quoted `$VAR` or `${VAR}` is not text, it EXPANDS — so blanking
	// it hid `echo "$AWS_SECRET_ACCESS_KEY"` from secret-env-print while the
	// unquoted form was caught. Single quotes do not expand, so they stay
	// blanked. Only the expansion survives; the literal text around it does
	// not, which is what keeps `git commit -m "fix rm -rf handling"` quiet.
	let expanding = false;
	let braced = false;
	let braceLiteral = false;

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
			if (char === quote) {
				out += char;
				quote = undefined;
				expanding = false;
				braced = false;
				continue;
			}
			if (quote === '"') {
				if (char === "$") {
					expanding = true;
					braced = false;
					out += char;
					continue;
				}
				if (expanding) {
					if (braced) {
						// Only the NAME survives. A `${...}` body carries literal text —
						// defaults (`${MSG:-fix rm -rf handling}`), substring ops,
						// replacements — and emitting it verbatim put that text back in
						// front of the table, which is the false positive this whole
						// function exists to prevent. Blank from the first character that
						// cannot be part of a name, keep the closing brace as a boundary.
						if (char === "}") {
							out += char;
							expanding = false;
							braced = false;
							braceLiteral = false;
							continue;
						}
						// Latches: once past the name, everything to `}` is literal text,
						// including later name-shaped words. `${MSG:-fix rm}` must not
						// leak `fix rm` back after blanking only the `:-`.
						if (!braceLiteral && !/[A-Za-z0-9_]/.test(char)) braceLiteral = true;
						out += braceLiteral ? " " : char;
						continue;
					}
					if (char === "{") {
						braced = true;
						out += char;
						continue;
					}
					if (/[A-Za-z0-9_]/.test(char)) {
						out += char;
						continue;
					}
					expanding = false;
				}
			}
			out += " ";
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
 * The two findings a delete confined to scratch space does not deserve.
 *
 * Only these. `shred`, `dd`, `mkfs` and the rest still ask wherever they point:
 * the argument below is about what is *in* the directory, and none of those are
 * about their target's contents being regenerable.
 */
const SCRATCH_EXEMPT: ReadonlySet<string> = new Set(["rm-recursive", "rm-glob"]);

/**
 * System temp directories, as literal prefixes.
 *
 * `/private/tmp` and `/private/var` are the same places as `/tmp` and `/var` on
 * macOS, so both spellings are listed rather than normalised — this file is pure
 * and does not get to call `realpath`.
 */
const SCRATCH_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

/**
 * True when a segment is an `rm` whose every target is a literal path inside the
 * system temp directory.
 *
 * ## Why this exemption exists
 *
 * `rm -rf` asks in every mode, which is right for `dist` and essential for
 * `~/Documents` — and wrong for the scratch directory an agent just made. Any
 * agent that creates `/tmp/bench-run` cleans it up, so the table produced a
 * prompt for a delete of something that by definition cannot be lost: nothing
 * survives a reboot there, and nothing is put there that is not reproducible.
 * A prompt you always approve is worse than no prompt, because it is the one
 * that trains you to approve the next one without reading it.
 *
 * ## Why it is written this bluntly
 *
 * Every rule below rejects rather than reasons, in the style of trivial.ts, and
 * rejection is free: it means the command asks, exactly as it did before.
 *
 *   - Every non-flag token must be an absolute literal path under one of
 *     SCRATCH_ROOTS with at least one segment below it. `rm -rf /tmp` and
 *     `rm -rf /tmp/` are not deletes of something in scratch space — they are
 *     deletes OF scratch space, including whatever another process is using.
 *   - `$` or a backtick anywhere rejects. `rm -rf $TMPDIR/build` is not literal,
 *     and with `TMPDIR` unset it is `rm -rf /build`. (`dynamic-argument` fires on
 *     it independently and is not exempted here, so it would still ask — but
 *     this must not be the thing standing between you and that, and reading a
 *     second rule to know a first one is safe is how holes are made.)
 *   - A `..` segment anywhere rejects: `/tmp/../etc` is under the prefix as a
 *     string and nowhere near it on disk.
 *   - A glob in the FIRST segment below the root rejects, which is the same rule
 *     as the one above it wearing a different coat: `rm -rf /tmp/*` empties all
 *     of scratch space — every other process's sockets and working files — and
 *     is a delete OF it, not of something in it. `/tmp/.*` is worse, since it
 *     has historically expanded over `..`. A glob deeper down is fine, because
 *     the directory it is confined to was named literally: `/tmp/bench/*` can
 *     only reach inside `/tmp/bench`.
 *   - A trailing slash rejects. BSD `rm -rf /tmp/link/` follows the symlink that
 *     `rm -rf /tmp/link` would merely unlink, and telling those apart needs the
 *     filesystem. The miss costs one prompt.
 *   - Any quote character rejects, so targets can be split on whitespace. The
 *     alternative is a quote-aware tokeniser, and a second parser of shell
 *     syntax whose disagreements with the first one are exactly where a hole
 *     would live is a bad trade for `rm -rf '/tmp/with space'` — which asks, as
 *     it always did.
 *   - No targets at all rejects, so a bare `rm -rf` never qualifies.
 */
export function deletesOnlyScratch(segment: string): boolean {
	const text = segment.trim();
	if (!/^rm(\s|$)/.test(text)) return false;
	if (/[$`'"]/.test(text)) return false;

	let targets = 0;

	for (const token of text.split(/\s+/).slice(1)) {
		// `--` ends the flags; it is not itself a target.
		if (token === "--") continue;
		if (token.startsWith("-")) continue;

		if (token.endsWith("/")) return false;
		if (/(?:^|\/)\.\.(?:\/|$)/.test(token)) return false;

		const root = SCRATCH_ROOTS.find((prefix) => token.startsWith(prefix));
		if (!root) return false;
		if (token.length <= root.length) return false;

		// The directory immediately below the root has to be named, not matched.
		const below = token.slice(root.length).split("/", 1)[0] ?? "";
		if (/[*?[]/.test(below)) return false;

		targets++;
	}

	return targets > 0;
}

/**
 * Every reason this command is considered destructive. Empty means it is not.
 *
 * `allow` lists pattern ids to ignore, so a user who genuinely does not want to
 * be asked about, say, `git-amend` can silence exactly that one.
 */
/**
 * Files whose contents get executed rather than read.
 *
 * The list is deliberately about *execution*, not about text: a `.md` that
 * quotes `ngrok http 3000` is documentation — this repo's own README does
 * exactly that — while a `.sh` containing the same line is the command with one
 * extra step in front of it.
 *
 * Two kinds, because they have to be read differently:
 *
 *   "script" — the file IS a sequence of commands, so a hard pattern counts
 *     only when it starts a line. That distinction is what keeps source code
 *     writable: `const D = ["ngrok http 3000"]` in a test corpus and
 *     `// pass --share` in a comment are not commands, and refusing them would
 *     have made this repo's own corpus.test.ts uneditable.
 *   "config" — the file is not commands, but names some: package.json's
 *     `scripts`, a CI workflow's `run:`. The command sits mid-line by
 *     construction, so anchoring cannot be required and the value is read
 *     wherever it appears.
 *
 * An extensionless file is only a script when it says so with a shebang.
 * `CHANGELOG` and `LICENSE` have no extension either.
 */
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|fish|ksh|command|ps1|bat|cmd|py|rb|pl|php|js|mjs|cjs|ts|mts|cts|tsx|jsx)$/i;

/** Files that are not commands but hand commands to something that runs them. */
const CONFIG_TARGET = /(?:^|\/)(?:package\.json|Makefile|Dockerfile|docker-compose\.ya?ml|Procfile)$|(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(?:^|\/)\.(?:gitlab-ci|travis|circleci\/config)\.ya?ml$/i;

export type TargetKind = "script" | "config" | undefined;

export function executableKind(path: string, text = ""): TargetKind {
	if (CONFIG_TARGET.test(path)) return "config";
	const name = path.split("/").pop() ?? path;
	if (SCRIPT_EXTENSION.test(name)) return "script";
	// `bin/deploy` is a script; `CHANGELOG` is not. A shebang is the only thing
	// that tells them apart, and it is what the kernel uses too.
	if (!name.slice(1).includes(".") && /^#!/.test(text.trimStart())) return "script";
	return undefined;
}

export function isExecutableTarget(path: string, text = ""): boolean {
	return executableKind(path, text) !== undefined;
}

/**
 * Where a segment sends its output, when that is a file it would create.
 *
 * Covers the spellings a redirect actually takes: a bare `>`/`>>`, an explicit
 * descriptor (`1>`), the noclobber override (`>|`), and a pipe into `tee`,
 * which is a redirect wearing a different hat. Missing any of them is missing
 * the content scan entirely, since `echo` blanks its own quoted argument on
 * the normal path.
 */
export function redirectTarget(segment: string): string | undefined {
	const tee = /\|\s*(?:sudo\s+)?tee\s+(?:-\S+\s+)*(['"]?)([^\s'"|;&<>]+)\1/.exec(segment);
	if (tee) return tee[2];
	const match = /(?:^|[^<>&|])\d?>[>|]?\s*(?!&)(['"]?)([^\s'"|;&<>]+)\1/.exec(segment);
	return match?.[2];
}

/**
 * Hard findings in text that is about to become an executable file.
 *
 * Scanned line by line, because each line of a script is its own command and
 * several hard patterns anchor at the start of one. Only the hard tier is
 * reported: an ordinary destructive line inside a file the agent is writing is
 * not a finding, since a write is judged on where it lands (see prompt.ts) and
 * a script full of `rm -rf build` is a build script.
 */
export function findHardInContent(path: string, text: string): Finding[] {
	const kind = executableKind(path, text);
	if (kind === undefined) return [];
	return hardInLines(text, kind);
}

/**
 * Hard patterns over text that will be run rather than read.
 *
 * A line is judged as the command it is about to become, so backslash
 * continuations are joined first — the shell joins them before running them,
 * and a payload broken across `ng\` / `rok http 3000` is one command with a
 * line break in the middle of it, not two.
 *
 * In a script the match must start the line: that is what separates a command
 * from a string literal or a comment that happens to quote one. In a config
 * file the command is a value sitting mid-line by construction, so it is read
 * wherever it appears.
 *
 * Deliberately does not call findDestructive: several hard patterns anchor with
 * `^`, and going through the full finder would re-enter the redirect handling.
 */
function hardInLines(text: string, kind: Exclude<TargetKind, undefined>): Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();
	const joined = text.replace(/\\\r?\n/g, "");
	for (const line of joined.split(/\r?\n/)) {
		for (const segment of splitSegments(line)) {
			// In a script, only what the shell would treat as the command word
			// counts. In a config, the whole value does.
			const subject = kind === "script" ? segment.trimStart() : segment;
			for (const pattern of PATTERNS) {
				if (pattern.hard !== true || seen.has(pattern.id)) continue;
				if (!matchesAsCommand(pattern, subject, kind)) continue;
				seen.add(pattern.id);
				findings.push({ id: pattern.id, reason: pattern.reason, segment: subject.trim(), hard: true });
			}
		}
	}
	return findings;
}

/**
 * Whether a pattern fires on a line that is about to be executed.
 *
 * The unanchored alternatives inside a hard pattern (`\bngrok\s+http\b`) are
 * what make a string literal in a `.ts` corpus look like an invocation, so in a
 * script they only count when the match begins the line. `public-share` is
 * exempt: `demo.launch(share=True)` is a real Gradio call and never starts one.
 */
function matchesAsCommand(pattern: Pattern, subject: string, kind: Exclude<TargetKind, undefined>): boolean {
	if (!pattern.test.test(subject)) return false;
	if (kind === "config" || pattern.id === "public-share") return true;
	const at = pattern.test.exec(subject);
	return at?.index === 0;
}

/**
 * What a redirecting command would put in the file: the segment with the
 * writing command, its redirect, and the quoting all taken off.
 *
 * `echo 'cpolar http 8080' >> setup.sh` becomes `cpolar http 8080`, which is
 * what has to be judged — as a line of a script, from its start, since that is
 * how it will run.
 */
export function redirectPayload(segment: string): string {
	const withoutRedirect = segment
		.replace(/\|\s*(?:sudo\s+)?tee\s+(?:-\S+\s+)*['"]?[^\s'"|;&<>]+['"]?/, "")
		.replace(/(?:^|[^<>&|])\d?>[>|]?\s*(?!&)['"]?[^\s'"|;&<>]+['"]?/, "");
	// The writer, then anything standing between it and the text: `echo -e`,
	// `echo -n`, and printf's format string, which is an argument rather than a
	// flag. Stripping only the first token left the payload starting with `-e`,
	// and every anchored pattern then failed to match the line it was about to
	// become.
	let rest = withoutRedirect.trim().replace(/^\S+\s*/, "");
	for (;;) {
		const next = rest.replace(/^(?:-{1,2}[A-Za-z][\w-]*(?:=\S+)?|(['"])%[^'"]*\1|%\S+)\s*/, "");
		if (next === rest) break;
		rest = next;
	}
	return rest.replace(/['"]/g, "").trim();
}

export function findDestructive(command: string, allow: ReadonlySet<string> = new Set()): Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();

	const consider = (raw: string) => {
		// Judge inert commands on their unquoted parts only, but keep the original
		// text for display so the prompt shows what was actually requested.
		const segment = INERT_COMMANDS.test(raw) ? blankQuoted(raw) : raw;
		const scratch = deletesOnlyScratch(segment);

		for (const pattern of PATTERNS) {
			// A hard pattern ignores the opt-out list. `allowDestructive` is how a
			// user says "stop asking me about this class"; for these there is no
			// asking to stop, and a settings key that silently disarmed a refusal
			// would make the refusal a suggestion.
			if (pattern.hard !== true && allow.has(pattern.id)) continue;
			if (scratch && SCRATCH_EXEMPT.has(pattern.id)) continue;
			if (!pattern.test.test(segment)) continue;
			const key = `${pattern.id}::${raw}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({ id: pattern.id, reason: pattern.reason, segment: raw, ...(pattern.hard ? { hard: true as const } : {}) });
		}

		// `echo 'ngrok http 3000' > run.sh` is the blocked command with one step
		// in front of it, and the step that follows — `bash run.sh` — is opaque
		// to every pattern here. Inert commands are normally judged on their
		// unquoted parts, which is what keeps `git commit -m 'fix rm -rf
		// handling'` quiet; but a redirect into a file that gets EXECUTED makes
		// the quoted text a payload rather than a mention, so it is judged as
		// the script line it is about to become. Only the hard tier: an ordinary
		// destructive string written into a script is still just a script.
		// An extensionless redirect target counts as a script here, where the
		// same path would need a shebang coming from the `write` tool. The
		// shebang rule exists because `write` is how CHANGELOG and LICENSE get
		// created; `echo … > bin/start` is not how prose gets written, and the
		// payload still has to match at the start of a line to count. Passing a
		// shebang says exactly that, in the one argument that decides it.
		const target = redirectTarget(raw);
		if (target !== undefined && isExecutableTarget(target, "#!")) {
			for (const finding of hardInLines(redirectPayload(raw), "script")) {
				const key = `${finding.id}::${raw}`;
				if (seen.has(key)) continue;
				seen.add(key);
				findings.push({ ...finding, segment: raw });
			}
		}

		// `bash -c 'cpolar http 8080'` is the same move without a file: the
		// payload is a script, quoted, and the outer command is a shell. Segment
		// splitting keeps quotes intact, so the inner text never reaches a
		// pattern on its own and a one-word wrapper lifted the refusal.
		const inlineScript = /^\s*(?:(?:sudo|doas|env|nohup|time|command|exec)\s+(?:-\S+\s+)*|\w+=\S+\s+)*(?:\S*\/)?(?:ba|z|k|da|fi)?sh\s+(?:-\S+\s+)*-\S*c\s+(['"])([\s\S]*)\1\s*$/.exec(raw);
		if (inlineScript?.[2] !== undefined) {
			for (const finding of hardInLines(inlineScript[2], "script")) {
				const key = `${finding.id}::${raw}`;
				if (seen.has(key)) continue;
				seen.add(key);
				findings.push({ ...finding, segment: raw });
			}
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
					// The one reason phrased as an explanation rather than a verb
					// phrase, so it is the one that needs a label of its own.
					label: "commands whose targets are computed at runtime",
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
