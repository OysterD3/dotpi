/**
 * Tool permissions for pi, in the conventional `settings.json` shape.
 *
 * pi ships nothing like this. Its security documentation is explicit: "Pi does
 * not include a built-in sandbox. Built-in tools can read files, write files,
 * edit files, and run shell commands with the permissions of the pi process."
 * The only gate available to an extension is the `tool_call` event, which can
 * block a call before it runs — that is what this uses.
 *
 * Rules use the conventional syntax so a settings file can be carried across:
 *
 *   { "permissions": {
 *       "defaultMode": "askDestructive",
 *       "deny":  ["Read(**\/.env)", "Bash(curl * | sh)"],
 *       "ask":   ["Bash(git push *)"],
 *       "allow": ["Bash(git status)", "Bash(pnpm test *)"]
 *   } }
 *
 * The default mode is `askDestructive`: everything runs without a prompt except
 * commands that destroy work, publish, or escalate privilege. Those are matched
 * by a readable table in destructive.ts — deterministic, so it is fast, works
 * offline, costs nothing, and can be audited by reading it.
 *
 * `auto` is that mode plus a model's second opinion on everything the table
 * cleared. The classifier can only ever turn an allow into an ask — see auto.ts
 * for why that bound is the entire reason it is safe to put a model here.
 *
 *   config.ts       modes and their ordering
 *   settings.ts     loading and layering the JSON files
 *   rules.ts        rule syntax: parsing and matching
 *   glob.ts         path and command pattern matching
 *   destructive.ts  what counts as destructive, and why
 *   decide.ts       precedence: deny > destructive > ask > allow > mode
 *   auto.ts         auto mode: the classifier, its cache, and its bounds
 *   prompt.ts       what the classifier is shown (pure)
 *   classify.ts     one classifier call and its verdict
 *   model.ts        resolving permissions.auto.model
 *
 * Scope limit worth knowing: this gates tool calls pi routes through extensions.
 * It is a guardrail against an agent doing something you did not intend, not a
 * sandbox — it cannot contain code that is already running.
 */

import { getAgentDir, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { AutoClassifier } from "./auto.ts";
import { AUTO, CONFIG, CYCLE, CYCLE_KEY, isMode, MODE_HELP, MODE_ORDER, nextMode, SCRATCHPAD, WORKSPACE, type Mode } from "./config.ts";
import { decide, type CompiledPolicy, type Decision } from "./decide.ts";
import { findDestructive, PATTERNS } from "./destructive.ts";
import { type Grant, SessionGrants } from "./grants.ts";
import { buildQuestion, subjectOf } from "./prompt.ts";
import { parseRules, ruleTarget } from "./rules.ts";
import { escapesScratchpad, usableScratchDir } from "./scratch.ts";
import { loadSettings, projectSettingsPath, userSettingsPath } from "./settings.ts";
import { type Verdict } from "./verdict.ts";
import { workspaceDirs } from "./workspace.ts";

function compile(agentDir: string, cwd: string, trusted: boolean): { policy: CompiledPolicy; report: string[] } {
	const { settings, sources, warnings } = loadSettings(agentDir, cwd, trusted);

	const allow = parseRules(settings.allow);
	const ask = parseRules(settings.ask);
	const deny = parseRules(settings.deny);

	const known = new Set(PATTERNS.map((pattern) => pattern.id));
	known.add("dynamic-argument");
	const unknownIds = settings.allowDestructive.filter((id) => !known.has(id));

	return {
		policy: {
			allow: allow.rules,
			ask: ask.rules,
			deny: deny.rules,
			settings,
			allowDestructive: new Set(settings.allowDestructive),
		},
		report: [
			...warnings,
			...allow.errors.map((error) => `allow: ${error}`),
			...ask.errors.map((error) => `ask: ${error}`),
			...deny.errors.map((error) => `deny: ${error}`),
			...unknownIds.map((id) => `allowDestructive: unknown pattern id "${id}"`),
			...sources.map((source) => `loaded ${source}`),
		],
	};
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let loaded: CompiledPolicy | undefined;
	let report: string[] = [];

	/**
	 * The mode Shift+Tab put us in, overriding the settings files for this session.
	 *
	 * Deliberately not written back to settings.json. A keystroke is how you say
	 * "for the next ten minutes"; a durable policy change should be a deliberate
	 * edit to a file you can read later, not a residue of tabbing. Cleared on
	 * session_start, so a new session starts from what the files say.
	 *
	 * It can loosen as well as tighten, including past a restriction an untrusted
	 * project asked for. That is consistent rather than a hole: a human at the
	 * keyboard can already approve any individual prompt, so denying them the
	 * mode switch would buy nothing but keystrokes.
	 */
	let override: Mode | undefined;

	/** The policy actually in force: the files, with the session override applied. */
	let policy: CompiledPolicy | undefined;

	const applyOverride = () => {
		policy =
			loaded && override
				? { ...loaded, settings: { ...loaded.settings, defaultMode: override } }
				: loaded;
	};

	/** Approvals granted for the rest of the session. */
	const grants = new SessionGrants();

	/**
	 * Directories `/add-dir` put in the workspace for this session, as last
	 * announced by the add-dir extension (see WORKSPACE in config.ts).
	 *
	 * Deliberately NOT cleared in `session_start`. Extension handlers for that
	 * event run in an order nothing here controls, so a clear there would be a
	 * race against add-dir's own handler, which is what publishes the restored
	 * list — and losing that race would silently drop every directory on a resume.
	 * Each message replaces the list outright, and add-dir publishes on session
	 * start, so there is nothing a clear would add.
	 */
	let sessionDirs: string[] = [];

	pi.events.on(WORKSPACE.channel, (data) => {
		const dirs = (data as { dirs?: unknown } | undefined)?.dirs;
		if (!Array.isArray(dirs)) return;
		sessionDirs = dirs.filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
	});

	/**
	 * This session's scratchpad, as last announced (see SCRATCHPAD in config.ts).
	 *
	 * Not cleared in `session_start`, for the same reason `sessionDirs` above is
	 * not: handler order across extensions is not something this file controls, so
	 * a clear there would race the scratchpad extension's own handler — the one
	 * that publishes the path — and losing that race would silently take the
	 * exemption away for the whole session.
	 *
	 * Clearing is the publisher's job instead. Every message replaces this
	 * outright, and one with no usable path clears it — which is how a session
	 * that turned the scratchpad off, or could not create one, takes the previous
	 * session's exemption away rather than leaving a dead directory allowed.
	 */
	let scratchDir: string | undefined;

	pi.events.on(SCRATCHPAD.channel, (data) => {
		const dir = (data as { dir?: unknown } | undefined)?.dir;
		scratchDir = typeof dir === "string" && dir.length > 0 ? dir : undefined;
	});

	/**
	 * The workspace as the classifier should see it: cwd, the settings key,
	 * `/add-dir`, and the scratchpad.
	 *
	 * The scratchpad is in the list because the classifier's own prompt only
	 * recognises scratch space by hardcoded temp spellings (`/tmp`, `/var/folders`
	 * and friends), so a `scratchpad.root` pointed anywhere else — `~/scratch`,
	 * say — read to it as an ordinary path outside the project, and bash commands
	 * touching the scratchpad got flagged for "touching the home directory". The
	 * path-tool exemption never had that problem because it consults the announced
	 * directory; this closes the same gap for the calls that still go to a model.
	 */
	const dirsFor = (cwd: string): string[] =>
		workspaceDirs(
			cwd,
			policy?.settings.additionalDirectories ?? [],
			sessionDirs,
			usableScratchDir(scratchDir, cwd) ? [scratchDir as string] : [],
		);

	/**
	 * Auto mode's classifier. Built unconditionally and idle unless the mode is
	 * `auto` — it holds a cache and a counter, not a connection, so there is
	 * nothing to start and nothing to tear down when the mode changes on reload.
	 */
	const classifier = new AutoClassifier((spend) => {
		pi.events.emit(AUTO.spendChannel, {
			source: AUTO.spendSource,
			usage: {
				input: spend.input,
				output: spend.output,
				cacheRead: spend.cacheRead,
				cacheWrite: spend.cacheWrite,
				reasoning: spend.reasoning,
				cost: spend.cost,
			},
			calls: 1,
		});
	});

	const rebuild = (cwd: string, trusted: boolean) => {
		const built = compile(agentDir, cwd, trusted);
		loaded = built.policy;
		report = built.report;
		applyOverride();
	};

	/**
	 * Move the session to `next`. Returns what to tell the user.
	 *
	 * Cached classifier verdicts are dropped on every change, in both directions.
	 * Leaving auto and coming back would otherwise reuse answers from before the
	 * user changed their mind about how much checking they wanted.
	 */
	const setMode = (next: Mode): string => {
		override = next === loaded?.settings.defaultMode ? undefined : next;
		applyOverride();
		classifier.clear();

		const suffix =
			next === "auto" && !policy?.settings.auto.model
				? "\nRunning on the session model — set permissions.auto.model to a small one to make this cheap."
				: override === undefined
					? "\nBack to what your settings files say."
					: "";
		return `Permissions: ${next} — ${MODE_HELP[next]}${suffix}`;
	};

	pi.on("session_start", (_event, ctx) => {
		// A keystroke override belongs to the session that saw the keystroke.
		override = undefined;
		rebuild(ctx.cwd, ctx.isProjectTrusted());
		// Verdicts are session-scoped by design, and a new session can be a new cwd
		// and a new policy — a cached "safe" reached under the old one has no
		// standing here. Also re-arms the degraded-mode warning.
		classifier.clear();
		const problems = report.filter((line) => !line.startsWith("loaded "));
		if (problems.length > 0) ctx.ui.notify(`Permissions:\n${problems.join("\n")}`, "warning");
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!policy) return undefined;

		const input = event.input as Record<string, unknown>;
		const call = { tool: event.toolName, input, cwd: ctx.cwd, scratchDir };
		let decision = decide(policy, call);

		// The one allow that is not final on its own. decide() answered by comparing
		// text, which cannot see that `<scratch>/notes.txt` is a symlink to
		// `~/.ssh/id_rsa`; this is where that gets checked against the filesystem.
		// An escape does not deny — it just withdraws the exemption and lets the
		// call be judged as what it is, a path outside the scratchpad.
		if (decision.scratch && scratchDir) {
			const target = ruleTarget(event.toolName, input);
			if (target !== undefined && escapesScratchpad(target, ctx.cwd, scratchDir)) {
				decision = decide(policy, { ...call, scratchDir: undefined });
			}
		}

		if (decision.behavior === "allow") return undefined;

		if (decision.behavior === "deny") {
			ctx.ui.notify(`Blocked ${event.toolName}: ${decision.reason}`, "error");
			return { block: true, reason: `Permission denied — ${decision.reason}` };
		}

		// `ruleTarget` only knows bash and the path tools, so every custom or MCP
		// tool used to fall back to "" — an approval prompt with a blank line where
		// the call should be, and no "allow this exact call" option, leaving a
		// blanket tool-wide grant as the only way to stop being asked. auto mode is
		// the first everyday mode that prompts for those tools at all, so it is
		// what made the gap visible. `subjectOf` already renders their arguments
		// for the classifier; the human deciding deserves at least as much.
		const target = ruleTarget(event.toolName, input) ?? subjectOf(event.toolName, input).body;
		const findings = decision.findings ?? [];
		const grantContext = { tool: event.toolName, target, findings, rule: decision.rule };

		// Checked only after deny: a grant can lift an ask, never a hard block.
		// It is also checked ahead of the classifier, so a command you approved
		// earlier in the session is never paid for a second time.
		if (grants.covers(grantContext)) return undefined;

		if (decision.behavior === "classify") {
			const auto = policy.settings.auto;

			// A headless run whose "ask" already means "allow" would be buying a
			// verdict it is contractually going to ignore. Skipping is not a
			// loosening — askWithoutUi decided this call's outcome before we got here.
			if (!ctx.hasUI && policy.settings.askWithoutUi === "allow") return undefined;

			const verdict = await classifier.judge(ctx, event.toolName, input, auto, dirsFor(ctx.cwd));

			// The classifier's entire authority: it can turn this allow into an ask.
			// Nothing below reaches a deny, and `safe` returns to exactly where the
			// call would have been without auto mode at all.
			if (verdict.kind === "safe") return undefined;

			if (verdict.kind === "aborted") {
				return { block: true, reason: "Permission check was interrupted before this call was approved" };
			}

			if (verdict.kind === "error") {
				if (classifier.shouldReport()) ctx.ui.notify(degradedMessage(verdict, auto.onError), "warning");
				if (auto.onError === "allow") return undefined;
				decision = { behavior: "ask", reason: `the auto classifier could not be reached — ${verdict.reason}` };
			} else {
				// Attributed out loud. A user must be able to tell a prompt raised by
				// the auditable table from one raised by a model's opinion, because
				// only one of those can be looked up and argued with.
				decision = { behavior: "ask", reason: `auto classifier: ${verdict.reason}` };
			}
		}

		if (!ctx.hasUI) {
			if (policy.settings.askWithoutUi === "allow") return undefined;
			return {
				block: true,
				reason: `Permission required — ${decision.reason} — and there is no interactive session to approve it`,
			};
		}

		// Announced only once a human is certain to be blocked — after the grant
		// and no-UI paths have had their say. Anything wanting to surface the
		// wait (the cmux bridge, a desktop notifier) subscribes to this rather
		// than reimplementing the decision. `permissions:answered` closes it.
		const announceAsk = () =>
			pi.events.emit("permissions:ask", {
				tool: event.toolName,
				target,
				reason: decision.reason,
				findings: findings.map((finding) => finding.id),
				sessionId: ctx.sessionManager.getSessionId() ?? undefined,
				cwd: ctx.cwd,
			});
		announceAsk();

		const options = buildOptions(event.toolName, target, decision);

		/**
		 * The deadline this prompt races against.
		 *
		 * A benchmark of this exact harness recorded four silent stalls of
		 * 9.5-16.8 minutes and one 6h12m overnight hang on the `ctx.ui.select`
		 * below, with no one at the keyboard and no way for the call to give up
		 * on its own — the human eventually unstuck a *different* wedged prompt
		 * with Escape and took an unrelated 3-hour turn down with it. 0 keeps
		 * today's unbounded wait for anyone who deliberately wants it.
		 *
		 * `signal` is the one lever `ExtensionUIDialogOptions` gives an extension
		 * to close a dialog it does not own — verified against both the
		 * interactive and RPC implementations, which resolve the same
		 * `undefined` an Escape produces and tear the dialog down. That shared
		 * result is exactly why the deadline is tracked in `timedOut` here
		 * rather than inferred from the resolved choice: `undefined` alone
		 * cannot tell a bored deadline from a deliberate no.
		 */
		const timeoutMs = policy.settings.promptTimeoutMs;
		const controller = new AbortController();
		let timedOut = false;
		let halfTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

		if (timeoutMs > 0) {
			// One repeat at the midpoint, not a recurring nag — elapsed's own
			// waitAlertMs already escalates a long wait on its own schedule. This
			// is only insurance for a notifier that missed the opening edge
			// (subscribed after it fired, dropped a push) against the prompt
			// giving up with them never having heard about it at all.
			halfTimer = setTimeout(announceAsk, timeoutMs / 2);
			deadlineTimer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
		}

		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(promptTitle(event.toolName, target, decision), options.map((o) => o.label), {
				signal: controller.signal,
			});
		} finally {
			if (halfTimer !== undefined) clearTimeout(halfTimer);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			// The closing edge of the same wait. Without it a subscriber can only
			// learn that the agent stopped, never that it started again — which is
			// why the turn clock could exclude a question but not an approval. In a
			// finally so a thrown or aborted prompt still releases it.
			pi.events.emit("permissions:answered", { tool: event.toolName });
		}

		// The deadline won the race. Blocking, not allowing, is the only safe
		// guess with nobody confirmed to be watching — and the reason has to be
		// one the model can act on unattended, or it just repeats the same call
		// and stalls again on the very next prompt.
		if (timedOut) {
			return { block: true, reason: timeoutReason(timeoutMs) };
		}

		const picked = options.find((option) => option.label === choice);

		// Escape and an explicit Block both mean no. Failing closed is the only
		// safe reading of "the user did not say yes".
		if (!picked || picked.grant === "block") {
			return { block: true, reason: `Permission denied by user — ${decision.reason}` };
		}

		if (picked.grant === "once") return undefined;

		if (picked.grant === "pattern") grants.addPatternGrants(findings);
		else grants.add(picked.grant);

		return undefined;
	});

	/**
	 * Shift+Tab cycles the mode, the way the comparable agent does it.
	 *
	 * pi ships Shift+Tab as `app.thinking.cycle`, and a reserved binding beats an
	 * extension's, so this silently does nothing until that one is moved. The
	 * README carries the agent/keybindings.json that frees it. Registering it
	 * regardless is the right call: the key is what was asked for, and a shortcut
	 * that starts working the moment the conflict is resolved beats one bound to a
	 * second-choice key forever.
	 */
	pi.registerShortcut(CYCLE_KEY, {
		description: "Cycle permission mode",
		handler: (ctx) => {
			if (!policy) return;
			const next = nextMode(policy.settings.defaultMode);
			if (!next) {
				ctx.ui.notify(
					`Permissions: staying on ${policy.settings.defaultMode} — Shift+Tab will not loosen it. Use /permissions mode <mode> to change it deliberately.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(setMode(next), "info");
		},
	});

	pi.registerCommand("permissions", {
		description:
			"Show or test tool permission rules (mode [<mode>] | test <command> | classify <command> | auto | reload | patterns | grants | forget)",

		getArgumentCompletions: (prefix) =>
			["test ", "classify ", "auto", "reload", "patterns", "grants", "forget", ...MODE_ORDER.map((mode) => `mode ${mode}`)]
				.filter((option) => option.startsWith(prefix))
				.map((value) => ({ value, label: value.trim() })),

		handler: async (args, ctx) => {
			const text = args.trim();

			if (text === "mode" || text.startsWith("mode ")) {
				if (!policy) return;
				const wanted = text.slice(4).trim();
				if (wanted.length === 0) {
					ctx.ui.notify(
						[
							`Mode: ${policy.settings.defaultMode}${override ? " (this session; Shift+Tab or /permissions mode)" : " (from your settings files)"}`,
							"",
							...MODE_ORDER.map((mode) => `  ${mode === policy?.settings.defaultMode ? "▸" : " "} ${mode.padEnd(15)} ${MODE_HELP[mode]}`),
							"",
							`Shift+Tab cycles: ${CYCLE.join(" → ")}`,
						].join("\n"),
						"info",
					);
					return;
				}
				if (!isMode(wanted)) {
					ctx.ui.notify(`Unknown mode "${wanted}". One of: ${MODE_ORDER.join(", ")}`, "error");
					return;
				}
				ctx.ui.notify(setMode(wanted), "info");
				return;
			}

			if (text === "auto") {
				if (!policy) return;
				const auto = policy.settings.auto;
				const stats = classifier.snapshot();
				const active = policy.settings.defaultMode === "auto";
				// Listed because it is the setting most likely to be silently wrong:
				// "why does it keep asking about my other repo" has no other way of
				// being answered, and a directory missing here is the whole bug.
				const workspace = dirsFor(ctx.cwd);
				ctx.ui.notify(
					[
						active
							? "Auto mode is ON — every call the rules do not settle goes to the classifier."
							: `Auto mode is OFF (mode is ${policy.settings.defaultMode}). Set permissions.defaultMode to "auto" to turn it on.`,
						"",
						`Model:              ${auto.model ?? "the session model (set permissions.auto.model to use a cheaper one)"}`,
						`In scope:           ${workspace[0]}${workspace.length > 1 ? `\n                    ${workspace.slice(1).join("\n                    ")}` : ""}`,
						// Listed for the same reason the workspace above it is: it silently
						// removes prompts, and "why did that write not ask" deserves an answer
						// you can look up rather than infer.
						`Scratchpad:         ${
							usableScratchDir(scratchDir, ctx.cwd)
								? `${scratchDir}\n                    (writes and edits under it are allowed without a classifier call)`
								: scratchDir
									? `${scratchDir}\n                    REFUSED — not a directory this may exempt; every call under it is judged normally`
									: "none announced — the scratchpad extension is not installed or is off"
						}`,
						`Read-only tools:    ${auto.skipReadOnly ? "skipped without asking (read, grep, find, ls)" : "classified like everything else"}`,
						`If unreachable:     ${auto.onError === "allow" ? "fall back to the destructive table alone" : "ask about every unrecognised call"}`,
						`Timeout:            ${auto.timeoutMs} ms`,
						"",
						`This session: ${stats.calls} classified (${stats.safe} cleared, ${stats.unsafe} raised a prompt, ${stats.errors} failed)`,
						`              ${stats.cached} answered from cache, ${formatTokens(stats.tokens)} tokens, ${formatCost(stats.cost)}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (text.startsWith("classify ")) {
				if (!policy) return;
				const command = text.slice(9).trim();
				if (command.length === 0) return;

				// The deterministic policy is consulted first, exactly as the live path
				// does it. Without this the command reported SAFE for things auto mode
				// would in fact stop: the system prompt tells the classifier not to
				// re-find force-pushes and `sudo` because the table already caught them,
				// so asking it about one in isolation gets the answer it was told to
				// give — while `/permissions test`, documented right beside this,
				// printed ASK for the same string.
				const settled = decide(policy, { tool: "bash", input: { command }, cwd: ctx.cwd, scratchDir });
				if (settled.behavior !== "classify") {
					ctx.ui.notify(
						`${command}\n\n=> ${settled.behavior.toUpperCase()} — ${settled.reason}\n   Settled before the classifier; it is never asked about this one.`,
						settled.behavior === "allow" ? "info" : "warning",
					);
					return;
				}

				// Deliberately the live path, cache and all, rather than a replica: a
				// dry run that exercised different code would be worth very little.
				const verdict = await classifier.ask(
					ctx,
					buildQuestion("bash", { command }, dirsFor(ctx.cwd)),
					policy.settings.auto,
				);
				ctx.ui.notify(
					`${command}\n\n=> ${describeVerdict(verdict)}`,
					verdict.kind === "safe" ? "info" : "warning",
				);
				return;
			}

			if (text === "grants") {
				const listed = grants.describe();
				ctx.ui.notify(
					listed.length === 0
						? "No session approvals. Every prompt is still being asked."
						: `Approved for this session (${listed.length}):\n${listed.map((line) => `  • ${line}`).join("\n")}\n\n/permissions forget revokes them.`,
					"info",
				);
				return;
			}

			if (text === "forget") {
				const count = grants.clear();
				// Cached verdicts go too. A remembered "safe" is an approval in every
				// sense that matters — it waves the next identical call through without
				// asking — so leaving it behind would make "forget" a half-truth.
				const verdicts = classifier.clear();
				// And so does the scratchpad. It is the largest standing approval in the
				// session — a whole directory that never prompts — so a command that
				// says "you will be asked again" while leaving it in place is telling
				// the user the one thing they ran it to stop being true. Dropped for
				// this session only: the next session_start re-announces it.
				const hadScratch = scratchDir !== undefined;
				scratchDir = undefined;
				ctx.ui.notify(
					count === 0 && verdicts === 0 && !hadScratch
						? "There were no session approvals to revoke."
						: [
								`Revoked ${count} session approval(s) and dropped ${verdicts} cached classifier verdict(s).`,
								...(hadScratch ? ["The scratchpad exemption is off too — writes there will be asked about like anywhere else."] : []),
								"You will be asked again.",
							].join(" "),
					"info",
				);
				return;
			}

			if (text === "reload") {
				rebuild(ctx.cwd, ctx.isProjectTrusted());
				// Verdicts were reached under the old settings — a different model, or
				// a different notion of what is skipped. Keeping them would let a
				// reload look like it took effect while old answers were still in use.
				classifier.clear();
				// The session override survives a reload — it is a layer above the
				// files, not a copy of them. But someone who just edited defaultMode
				// and reloaded to pick it up would otherwise watch nothing happen, so
				// the masking is stated rather than left to be discovered.
				const masked =
					override !== undefined
						? `\nStill on ${override} for this session (Shift+Tab), which is masking defaultMode ${loaded?.settings.defaultMode} from your files.`
						: "";
				ctx.ui.notify(
					`Permissions reloaded.\n${report.join("\n") || "no settings files found"}${masked}`,
					"info",
				);
				return;
			}

			if (text === "patterns") {
				const lines = PATTERNS.map((pattern) => `  ${pattern.id.padEnd(24)} ${pattern.reason}`);
				ctx.ui.notify(`Destructive patterns (${PATTERNS.length}):\n${lines.join("\n")}`, "info");
				return;
			}

			if (text.startsWith("test ")) {
				if (!policy) return;
				const command = text.slice(5).trim();
				const decision = decide(policy, { tool: "bash", input: { command }, cwd: ctx.cwd, scratchDir });
				const findings = findDestructive(command, policy.allowDestructive);
				const detail = findings.length
					? findings.map((finding) => `  - ${finding.id}: ${finding.reason}\n      ${finding.segment}`).join("\n")
					: "  (no destructive patterns matched)";
				// `test` stays free and offline, so a classify outcome is reported as
				// what it is — an unanswered question — rather than quietly billing a
				// model call for a command the user only wanted explained.
				const outcome =
					decision.behavior === "classify"
						? "CLASSIFY — the rules do not settle this; auto mode would ask the model\n           (/permissions classify <command> to actually ask it)"
						: `${decision.behavior.toUpperCase()} — ${decision.reason}`;
				ctx.ui.notify(
					`${command}\n\n=> ${outcome}\n${detail}`,
					decision.behavior === "allow" ? "info" : "warning",
				);
				return;
			}

			if (!policy) return;
			const { settings } = policy;
			const stats = classifier.snapshot();
			ctx.ui.notify(
				[
					`Mode: ${settings.defaultMode}${override ? " (this session — Shift+Tab)" : ""} — ${MODE_HELP[settings.defaultMode]}`,
					`Rules: ${policy.deny.length} deny, ${policy.ask.length} ask, ${policy.allow.length} allow`,
					// Shown in every mode, not just auto. It is an allow, so it suppresses
					// prompts in askMutating and askAll too — the modes someone picks
					// *because* they want to be asked about every write — and this line is
					// the only place that is visible. /permissions forget turns it off.
					...(usableScratchDir(scratchDir, ctx.cwd)
						? [`Scratchpad (writes never prompt): ${scratchDir}`]
						: []),
					`Destructive overrides allow: ${settings.destructiveOverridesAllow}`,
					`Without a UI, "ask" becomes: ${settings.askWithoutUi}`,
					`Prompt timeout: ${settings.promptTimeoutMs === 0 ? "none — waits forever" : `${formatDuration(settings.promptTimeoutMs)} (blocks on expiry)`}`,
					...(settings.defaultMode === "auto"
						? [
								`Auto classifier: ${settings.auto.model ?? "the session model"} — ${stats.calls} call(s) this session, ${formatCost(stats.cost)} (/permissions auto)`,
							]
						: []),
					`Session approvals held: ${grants.size()} (/permissions grants to list, forget to revoke)`,
					"",
					`User file:    ${userSettingsPath(agentDir)}`,
					`Project file: ${projectSettingsPath(ctx.cwd)}`,
					"",
					`Modes: ${MODE_ORDER.join(" < ")}`,
					...report.map((line) => `  ${line}`),
				].join("\n"),
				"info",
			);
		},
	});
}

/**
 * The one-time warning that auto mode is not actually auditing anything.
 *
 * Worth a warning rather than silence in either direction. With `onError:
 * "allow"` the session is running at `askDestructive` while the user believes a
 * model is checking their commands, which is the more dangerous
 * misunderstanding; with `"ask"` they are about to be prompted for everything
 * and deserve to know why.
 */
function degradedMessage(verdict: Extract<Verdict, { kind: "error" }>, onError: "allow" | "ask"): string {
	const consequence =
		onError === "allow"
			? "Falling back to the destructive-pattern table alone for the rest of this session — commands it does not recognise will run without a prompt."
			: "Every call the rules do not settle will ask, until it recovers.";
	return `Auto mode is degraded: ${verdict.reason}\n${consequence}`;
}

function describeVerdict(verdict: Verdict): string {
	switch (verdict.kind) {
		case "safe":
			return `SAFE — ${verdict.reason}`;
		case "unsafe":
			return `UNSAFE — ${verdict.reason}\n   (auto mode would prompt for this)`;
		case "error":
			return `NO VERDICT — ${verdict.reason}`;
		case "aborted":
			return "INTERRUPTED";
	}
}

function formatTokens(total: number): string {
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2)}M`;
	if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
	return String(total);
}

/** Sub-cent spend is the normal case for a small classifier, so it gets four places. */
function formatCost(cost: number): string {
	return cost === 0 ? "$0.0000" : `$${cost.toFixed(4)}`;
}

type PromptOption = { label: string; grant: Grant | "once" | "block" | "pattern" };

/**
 * The choices offered for one prompt.
 *
 * The grains are deliberately different sizes. "This exact command" is the safe
 * default for a one-off. The pattern grain is the one that actually saves you
 * during real work: when you are deleting twenty build directories, being asked
 * about each distinct path is the same nag with extra steps — what you want to
 * say is "yes, recursive deletes are fine right now".
 *
 * Only offered when it can be described precisely, so the user always knows the
 * exact scope of what they are approving.
 */
export function buildOptions(tool: string, target: string, decision: Decision): PromptOption[] {
	const options: PromptOption[] = [{ label: "Allow once", grant: "once" }];

	if (target.length > 0) {
		options.push({
			label: `Allow this exact command for the rest of this session`,
			grant: { kind: "exact", tool, target },
		});
	}

	const findings = decision.findings ?? [];
	if (findings.length > 0) {
		// This is the only STICKY option for a command whose text changes every
		// time, so it has to read like one. Interpolating the raw reason gave
		// "Allow anything that targets are computed at runtime, so what it
		// affects cannot be checked in advance for the rest of this session" —
		// a run-on that nobody recognises as "allow this whole class", so the
		// same class got approved once, over and over. A finding may carry a
		// short noun-phrase label for exactly this; the reason is the fallback,
		// and reads correctly for every other pattern.
		const described = [...new Set(findings.map((finding) => finding.label ?? `anything that ${finding.reason}`))];
		const shown = described.length === 1 ? described[0] : `${described.slice(0, 2).join(" or ")}${described.length > 2 ? ` (+${described.length - 2} more)` : ""}`;
		options.push({ label: `Allow ${shown} for the rest of this session`, grant: "pattern" });
	} else if (decision.rule !== undefined) {
		options.push({
			label: `Allow anything matching ${decision.rule} for the rest of this session`,
			grant: { kind: "rule", rule: decision.rule },
		});
	}

	options.push({
		label: `Allow every ${tool} call for the rest of this session`,
		grant: { kind: "tool", tool },
	});

	options.push({ label: "Block", grant: "block" });
	return options;
}

function promptTitle(tool: string, target: string, decision: Decision): string {
	const shown = target.length > CONFIG.promptCommandChars
		? `${target.slice(0, CONFIG.promptCommandChars)}…`
		: target;

	const reasons = decision.findings
		? [...new Set(decision.findings.map((finding) => finding.reason))]
		: [decision.reason];

	const listed = reasons.slice(0, CONFIG.maxReasonsShown).map((reason) => `  • ${reason}`);
	if (reasons.length > listed.length) listed.push(`  • …and ${reasons.length - listed.length} more`);

	return `Approve ${tool}?\n\n  ${shown}\n\n${listed.join("\n")}`;
}

/** "5m", "1m 30s", "45s" — whichever units are non-zero, floored to the second. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	// Always show seconds unless something coarser already did — "5m" alone
	// beats "5m 0s", but a sub-minute timeout must still print something.
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

/**
 * The block reason handed to the model when the deadline won the race in the
 * `tool_call` handler above, instead of a human.
 *
 * Actionable rather than a bare "timed out". The benchmark this setting is a
 * response to shows what an unactionable one does: the model retried the
 * identical blocked command across every stall, and the eventual Escape meant
 * to unstick it landed on a *different* prompt and killed a 3-hour turn. Each
 * clause heads off one way that repeats the same failure — retrying verbatim,
 * a `pkill` that can catch more than intended, an `rm -rf` that can too — and
 * "defer this step" gives it a way to make progress without a human at all,
 * which is the actual point of not blocking forever.
 */
export function timeoutReason(timeoutMs: number): string {
	return `Permission prompt timed out after ${formatDuration(timeoutMs)} with nobody at the keyboard. Do not retry this exact command. Kill by exact PID from your own pidfile instead of pkill; delete specific named files instead of rm -rf; or defer this step and continue other work.`;
}
