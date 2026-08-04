/**
 * ultracode — the workflow orchestration trigger.
 *
 * Two halves:
 *
 *   1. The `workflow` tool (tool.ts + engine.ts + spawn.ts): a script that
 *      orchestrates headless pi subagents with agent()/parallel()/pipeline().
 *      Runs are background by default (runs.ts), durable on disk (store.ts +
 *      journal.ts), resumable by replaying a journal, pausable while in
 *      flight, and driven from a control TUI (tui.ts) that shift+↓ at the
 *      prompt, or /workflows, opens.
 *      Agents can be forked a slice of this conversation (context.ts) and can
 *      borrow a standing subagent definition (agents.ts). Subagent models are
 *      routed in the triggering request itself ("ultracode, use sonnet for
 *      implementation and fable to review"): routing.ts notices that a request
 *      names models so the reminder can bind the instruction to that turn, and
 *      models.ts resolves the names the model passes with pi's own --model
 *      rules.
 *   2. The triggers that opt the model into using it:
 *      - the "ultracode" KEYWORD in a typed prompt opts in that single turn
 *        (detector and reminder text verbatim from the binary; the keyword
 *        changes nothing else — no effort bump, prompt not rewritten);
 *      - `/ultracode` turns the mode on for the session: thinking is raised to
 *        xhigh ("xhigh + dynamic workflow orchestration, this session only")
 *        and standing reminders follow a fixed cadence — full on entry, "still
 *        on" every 10th user turn, exit notice once when it goes off. Changing
 *        the thinking level away from xhigh exits the mode.
 *
 * Reminders are injected as hidden custom messages (display: false) via
 * before_agent_start — pi's own plan-mode pattern — so they reach the model as
 * <system-reminder> blocks without appearing in the transcript UI.
 *
 * Two things watch the opt-in itself, not just the request that grants it:
 *   - a background workflow's result is delivered via sendMessage's
 *     triggerTurn/followUp, and BOTH bypass before_agent_start entirely (see
 *     mode.ts's hasMessageSinceLastUserTurn) — so the reactive turn that
 *     processed a result carried no reminder, and if the keyword is not
 *     retyped, neither did every turn after it. Once the keyword has fired
 *     this session, the next real turn that follows a workflow result is
 *     still treated as opted in and gets the sparse reminder;
 *   - the keyword's tool description forbids un-opted-in workflow use, which
 *     made solo grinding the only path the model's own rules still allowed
 *     once that opt-in had decayed. A run of consecutive main-session
 *     edit/write calls (streak.ts), gated on the opt-in having ever been
 *     standing this session, gets a hidden mid-turn nudge every
 *     CONFIG.editStreakNudge calls, capped per turn.
 * Both are responses to the same measured run: a keyword that fired once, a
 * workflow that ran once, then 69 files hand-edited across 360 solo tool
 * calls with nothing left to say so.
 *
 * Known gaps, documented in README.md: no worktree isolation, no keyword
 * dismissal shortcut, and the keyword is detected on the pre-expansion text of
 * interactive input only.
 *
 * Settings (agent settings.json):
 *   ultracode.keywordTrigger  boolean, default true
 *   ultracode.model           "provider/model-id" for workflow subagents;
 *                             defaults to the session model
 *   ultracode.limits          overrides for concurrency, caps, timeouts,
 *                             retention and context budgets (config.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { COLLECT_CHANNEL, CONFIG, DEFAULT_SETTINGS, ENTRY_TYPE, PANEL_CHANNEL, SETTINGS_KEY, SPEND_CHANNEL, SPEND_SOURCE, type UltracodeSettings } from "./config.ts";
import { hasUltracodeKeyword } from "./keyword.ts";
import { hasMessageSinceLastUserTurn, UltracodeMode } from "./mode.ts";
import { interruptedNotice, panelLines, progressFromJournal, sessionRuns, spendRuns, startedLabel, statusReport } from "./panel.ts";
import { editStreakReminder, ENTER_SPARSE, KEYWORD_REMINDER, routingReminder, systemReminder } from "./reminders.ts";
import { findModelMentions, modelVocabulary } from "./routing.ts";
import { allAgents, RunRegistry } from "./runs.ts";
import { EDIT_STREAK_TOOLS, EditStreak, restoreEditStreak } from "./streak.ts";
import { ensureStore, listRuns, readJournalLines, readMeta, reconcile, runDir, unresumedInterrupted } from "./store.ts";
import { registerWorkflowTool, RESULT_MESSAGE, usableModels, WORKFLOW_TOOL_NAME } from "./tool.ts";
import { showWorkflows } from "./tui.ts";

const BADGE = "✦ ultracode";

interface ToggleEntry {
	action: "on" | "off";
	/** Thinking level to restore on /ultracode off; survives session resume. */
	previousLevel?: string;
}

export function loadSettings(agentDir: string): UltracodeSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			keywordTrigger: typeof block?.keywordTrigger === "boolean" ? block.keywordTrigger : DEFAULT_SETTINGS.keywordTrigger,
			model: typeof block?.model === "string" ? block.model : undefined,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export interface RestoredBranchState {
	/** Thinking level to restore on /ultracode off, if the mode is on. */
	previousLevel: string | undefined;
	/**
	 * Whether the keyword reminder has gone out at least once this session.
	 * Read alongside hasMessageSinceLastUserTurn to decide whether a turn
	 * following a workflow-result delivery is still opted in.
	 */
	keywordFired: boolean;
}

/**
 * Rebuild mode state from a resumed branch: toggle entries (type "custom") and
 * delivered reminders, which pi persists as type "custom_message" entries —
 * that is how before_agent_start-injected messages land in the session file.
 */
export function restoreFromBranch(mode: UltracodeMode, branch: Array<Record<string, any>>): RestoredBranchState {
	let on = false;
	let announced = false;
	let turns = 0;
	let previousLevel: string | undefined;
	let keywordFired = false;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			const data = entry.data as ToggleEntry | undefined;
			on = data?.action === "on";
			previousLevel = on ? data?.previousLevel : undefined;
			// An explicit off (this entry is /ultracode off's or
			// thinking_level_select's own log, both append it) wins over keyword
			// history recorded earlier in the branch — mirrors the live-session
			// reset in disable() / thinking_level_select below, so a resume can't
			// resurrect an opt-in the user already turned off.
			if (!on) keywordFired = false;
		} else if (entry.type === "custom_message" && entry.customType === ENTRY_TYPE) {
			const content = entry.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map((block: { text?: string }) => block.text ?? "").join("\n")
						: "";
			if (text.includes("Ultracode is off")) announced = false;
			else if (text.includes("Ultracode is")) {
				announced = true;
				turns = 0;
			}
			// Reminders combine onto one message (keyword first, see
			// before_agent_start below), so this is a substring check, not an
			// equality — a turn that also carried a routing or mode reminder
			// still counts.
			if (text.includes(KEYWORD_REMINDER)) keywordFired = true;
		} else if (entry.type === "message" && entry.message?.role === "user" && on && announced) {
			turns++;
		}
	}
	// A pending exit: the mode is off but the model was told it is on and the
	// exit notice never went out before the session ended.
	mode.restore({ on, announced, turnsSinceReminder: turns, exitPending: announced });
	return { previousLevel: on ? previousLevel : undefined, keywordFired };
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const mode = new UltracodeMode();
	const registry = new RunRegistry();
	const editStreak = new EditStreak();
	let settings: UltracodeSettings = loadSettings(agentDir);
	let keywordThisTurn = false;
	let settingLevel = false;
	let previousLevel: string | undefined;
	/** Whether the keyword reminder has fired at least once this session — see restoreFromBranch. */
	let keywordFiredThisSession = false;
	/**
	 * Whether the Workflow tool has been called at least once this session —
	 * the OTHER standing condition (besides /ultracode mode) that gates the
	 * edit-streak nudge in streak.ts. Sticky for the rest of the session once
	 * true: "has run" does not un-happen because the mode was toggled off.
	 */
	let workflowRanThisSession = false;
	/** Runs a dead session left in flight; the store knows this as fact. */
	let interruptedNote: string | undefined;
	/** The level ultracode actually applied ("xhigh", or "max" when clamped up). */
	let appliedLevel: string | undefined;
	/**
	 * The current pi session, so /workflows can list this session's runs and not
	 * fifty of history. Kept in a closure because getArgumentCompletions is
	 * handed only a prefix — there is no ctx to read it from at that point.
	 */
	let sessionId: string | undefined;
	/**
	 * This session's project directory, captured at session_start rather than
	 * read from a ctx later. The panel can be opened from a context pi has since
	 * retired, and reading ctx.cwd on a dead runtime throws.
	 */
	let sessionCwd: string | undefined;

	// ------------------------------------------------------------ status panel

	/** The freshest context whose ui the panel can draw through. */
	let uiCtx: ExtensionContext | undefined;
	let panelTimer: ReturnType<typeof setInterval> | undefined;

	const stopPanelTimer = () => {
		if (!panelTimer) return;
		clearInterval(panelTimer);
		panelTimer = undefined;
	};

	const drawPanel = () => {
		// Every field of a context belonging to a replaced session throws
		// (pi's getters call assertActive), and this runs from timers and from
		// run-settled callbacks that can outlive the session — an escape here
		// would take the process down. A dead context simply stops drawing.
		try {
			if (!uiCtx?.hasUI) return;
			const lines = panelLines(registry.active(), Date.now());
			// Announced, not drawn: the statusline appends these to the bottom of
			// the footer, so active runs are visible without opening /workflows.
			// ultracode stays out of the layout decision — anything else wanting
			// the same signal subscribes to the same channel.
			pi.events.emit(PANEL_CHANNEL, { lines });
			// Tick while runs are active so elapsed times move; stop when quiet.
			if (lines && !panelTimer) {
				panelTimer = setInterval(drawPanel, 2000);
				(panelTimer as { unref?: () => void }).unref?.();
			} else if (!lines) {
				stopPanelTimer();
			}
		} catch {
			uiCtx = undefined;
			stopPanelTimer();
		}
	};

	/**
	 * The one way into the control panel. Two doors reach it — the /workflows
	 * command and the shift+↓ gesture registered below — and the post-await
	 * setEditorText is load-bearing, so neither may inline its own copy.
	 */
	const openPanel = async (ctx: ExtensionContext) => {
		const result = await showWorkflows(pi, ctx, {
			agentDir,
			registry,
			sessionId,
			cwd: sessionCwd,
			notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
		});
		drawPanel();
		// The panel holds the editor's slot, and pi restores the editor's saved
		// text before it resolves this promise — so a resume instruction written
		// from inside the panel would be overwritten by whatever was in the
		// prompt when it opened. It is handed back as the result and written
		// here instead, after that restore.
		if (result) {
			ctx.ui.setEditorText(result.editorText);
			ctx.ui.notify(result.notice, "info");
		}
	};

	registerWorkflowTool(pi, {
		registry,
		agentDir,
		settings: () => settings,
		onRunEvent: drawPanel,
	});

	// --------------------------------------------------------------- spend
	//
	// Answered from the store, not from memory, and only when asked. A run's
	// cost used to be announced per subagent turn, which meant it existed
	// nowhere but the subscriber's heap: killing pi and resuming with `pi -c`
	// gave a session whose /usage total silently omitted two completed fleets,
	// with no warning available because the warning is keyed on having received
	// an announcement. run.json has the same numbers and outlives the process.
	//
	// Synchronous throughout — readMeta is readFileSync — because the report
	// that asked is built the moment this returns; see COLLECT_CHANNEL.
	//
	// One bound worth knowing: retention keeps the newest CONFIG.retainRuns
	// settled runs, so a session that starts more than that many stops being
	// able to account for its earliest. That is a 50-run session, and the
	// alternative — a second tally to survive pruning — is the memory-only
	// arrangement this replaced.
	pi.events.on(COLLECT_CHANNEL, () => {
		const now = Date.now();
		for (const meta of spendRuns(listRuns(agentDir), sessionId, (runId) => registry.get(runId) !== undefined)) {
			// Memory first for a run still in flight: run.json's usage is written on
			// a throttle, so the file can be a few seconds behind, and a report of a
			// running fleet should be as current as anything else on the screen.
			const usage = registry.get(meta.runId)?.progress.usage ?? meta.usage;
			// A run that has spent nothing yet is not a row. Its turns arrive later,
			// and the next report will ask again.
			if (!usage || usage.turns <= 0) continue;
			pi.events.emit(SPEND_CHANNEL, {
				source: SPEND_SOURCE,
				// The run id, so being asked twice cannot bill twice, and so a run
				// whose spend is already on a `wait: true` tool result can be
				// recognised there and dropped here.
				key: meta.runId,
				detail: `${meta.name} (${startedLabel(meta.startedAt, now)})`,
				calls: usage.turns,
				usage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					reasoning: usage.reasoning,
					// Flat, not `{ total }` — see SPEND_CHANNEL.
					cost: usage.cost,
				},
			});
		}
	});

	pi.registerEntryRenderer<ToggleEntry>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? new Text(theme.fg("accent", `✦ ultracode ${entry.data.action}`), 0, 0) : undefined,
	);

	const setBadge = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void }; hasUI: boolean }) => {
		if (ctx.hasUI) ctx.ui.setStatus("ultracode", mode.isOn() ? BADGE : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(agentDir);
		uiCtx = ctx;
		keywordThisTurn = false;
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? undefined;
			sessionCwd = ctx.cwd;
		} catch {
			sessionId = undefined;
		}
		const branch = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
		const restored = restoreFromBranch(mode, branch);
		previousLevel = restored.previousLevel;
		keywordFiredThisSession = restored.keywordFired;
		// A separate scan (streak.ts owns the tool-name vocabulary; restoreFromBranch
		// owns ENTRY_TYPE messages) rebuilds the OTHER piece of resumed state: how
		// far into an edit streak this session already was, and whether a workflow
		// has ever run in it — both keyed off toolResult entries, not custom ones.
		const editState = restoreEditStreak(branch, WORKFLOW_TOOL_NAME);
		editStreak.restore(editState.count);
		workflowRanThisSession = editState.workflowRan;
		appliedLevel = mode.isOn() ? pi.getThinkingLevel() : undefined;
		// Background runs do not survive a session ending. The store records
		// which ones died with their process, so the correction can be said out
		// loud — and, unlike before, each one names a resumable run id.
		ensureStore(agentDir);
		// reconcile() only reports what it just marked, so on its own the notice
		// fired exactly once per death: a run not resumed in the very next
		// session was never mentioned again. Runs still owed from earlier
		// sessions are gathered separately and repeated, quietly, until
		// something resumes them or they are pruned.
		const freshlyDead = reconcile(agentDir);
		const freshIds = new Set(freshlyDead.map((meta) => meta.runId));
		// Scoped to this project: the run store is global, and a resume would run
		// the old run's agents in whatever tree the current session is sitting in.
		const stillOwed = unresumedInterrupted(listRuns(agentDir), sessionCwd).filter((meta) => !freshIds.has(meta.runId));
		interruptedNote = interruptedNotice(freshlyDead, stillOwed);
		setBadge(ctx);
		drawPanel();
	});

	// Runs cannot outlive their session: subprocesses die with the abort. The
	// context is dropped here too — it becomes unusable the moment the session
	// is replaced, and cancelled runs settle after this point.
	pi.on("session_shutdown", () => {
		registry.cancelAll();
		// Cancel, then forget: a `/new` in the same process must not inherit the
		// previous session's runs, or its footer lines and its /usage total open
		// already spent. The cancelled runs settle through their own callbacks and
		// still write their final state to run.json.
		registry.clear();
		// One last announcement, so anything drawing the old session's runs (the
		// footer) clears rather than freezing on the last lines it saw. Spend
		// needs no such reset: nothing is announced until a report asks, and what
		// is answered then is scoped to whichever session is asking.
		pi.events.emit(PANEL_CHANNEL, { lines: undefined });
		stopPanelTimer();
		uiCtx = undefined;
	});

	// The text is scanned as typed, before any command expansion, and only for
	// human prompts. pi's input event is exactly that point. Prompts steered into
	// a running turn never reach before_agent_start, so they must not touch the
	// flag — a known gap, documented in README.md.
	pi.on("input", (event) => {
		if (event.streamingBehavior !== undefined) return { action: "continue" };
		keywordThisTurn = event.source === "interactive" && hasUltracodeKeyword(event.text);
		return { action: "continue" };
	});

	// Reminders ride the turn as one hidden custom message, keyword first, then
	// the session-mode reminder.
	pi.on("before_agent_start", (event, ctx) => {
		uiCtx = ctx;
		// Once per turn, so the edit-streak nudge's per-turn cap (streak.ts)
		// resets here rather than at a tool-call boundary that does not exist
		// for a turn triggered by a workflow-result delivery (see below).
		editStreak.newTurn();
		const parts: string[] = [];
		const triggered = keywordThisTurn && settings.keywordTrigger;
		if (triggered) {
			parts.push(KEYWORD_REMINDER);
			keywordFiredThisSession = true;
		}
		keywordThisTurn = false;

		// Routing is said in the request, so it is read off the request. Only
		// on turns that actually reach for a workflow — otherwise mentioning a
		// model in ordinary conversation would look like an instruction.
		if (triggered || mode.isOn()) {
			// Usable models only. A word that names a provider with no
			// credentials is not a routing instruction — following it sends the
			// whole fleet somewhere it cannot authenticate.
			const mentions = findModelMentions(event.prompt, modelVocabulary(usableModels(ctx)));
			if (mentions.length > 0) parts.push(routingReminder(mentions));
		}
		if (interruptedNote) {
			parts.push(interruptedNote);
			interruptedNote = undefined;
		}
		const modeReminder = mode.reminderForTurn();
		if (modeReminder) parts.push(modeReminder);
		// Opt-in persistence across a workflow-result delivery. Skipped once
		// `mode.isOn()` — the reminder above already covers that case on its own
		// cadence, independent of workflow timing — so this path exists only for
		// a keyword-only opt-in that /ultracode never turned into a standing
		// mode. "A workflow has run this session" is not tracked separately here:
		// finding its result in the branch already proves it, so checking for
		// the result IS the check (workflowRanThisSession is still tracked, for
		// streak.ts's independent need in the tool_call handler below).
		if (!triggered && !mode.isOn() && keywordFiredThisSession) {
			const currentBranch = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
			if (hasMessageSinceLastUserTurn(currentBranch, RESULT_MESSAGE)) parts.push(ENTER_SPARSE);
		}
		if (parts.length === 0) return;
		return {
			message: {
				customType: ENTRY_TYPE,
				content: parts.map(systemReminder).join("\n"),
				display: false,
			},
		};
	});

	// The edit-streak nudge. Fires only for MAIN-session tool calls: subagents
	// run as separate `pi --no-extensions` processes (spawn.ts), so this
	// extension is never even loaded there — nothing here can see, let alone
	// count, a subagent's edits. "Main-session" in streak.ts's own doc comment
	// is therefore automatic, not something this handler has to check for.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === WORKFLOW_TOOL_NAME) {
			// Delegated work, not solo grinding: the streak ends, and the opt-in
			// this session claims for the rest of the edit-streak gate is no
			// longer hypothetical.
			editStreak.reset();
			workflowRanThisSession = true;
			return;
		}
		// Gated on the opt-in being standing at all — plain single-file work
		// before either has ever been true is not the failure this watches for.
		if (!EDIT_STREAK_TOOLS.has(event.toolName) || !(mode.isOn() || workflowRanThisSession)) return;
		const streak = editStreak.recordEdit(CONFIG.editStreakNudge, CONFIG.editStreakMaxNudgesPerTurn);
		if (streak === null) return;
		pi.sendMessage(
			{ customType: ENTRY_TYPE, content: systemReminder(editStreakReminder(streak)), display: false },
			// Same idiom as advisor.ts's resurfaced-advice nudge: a tool call always
			// lands mid-turn in practice, but isIdle() is checked rather than
			// assumed, matching every other extension that injects a message from
			// inside a running turn.
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	});

	// Leaving the applied level exits the mode. Our own setThinkingLevel call is
	// guarded out. The user's explicit choice stands: no restore.
	pi.on("thinking_level_select", (event, ctx) => {
		if (settingLevel || !mode.isOn()) return;
		if (event.level === appliedLevel) return;
		mode.disable();
		// An explicit off, same as /ultracode off below: stale keyword history
		// must not resurrect the opt-in the user just left.
		keywordFiredThisSession = false;
		previousLevel = undefined;
		appliedLevel = undefined;
		pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { action: "off" });
		setBadge(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Ultracode off — thinking level changed to ${event.level}`, "info");
	});

	const setLevel = (level: string) => {
		settingLevel = true;
		try {
			pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
		} finally {
			settingLevel = false;
		}
	};

	const enable = (ctx: ExtensionContext) => {
		if (mode.isOn()) {
			ctx.ui.notify("Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)", "info");
			return;
		}
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("Ultracode needs a model selected.", "error");
			return;
		}
		// pi clamps the requested level to the model's supported set (upward
		// first, so models without xhigh but with max get max). Anything below
		// xhigh is a refusal: "Ultracode runs at xhigh effort, which <model>
		// doesn't support — switch to an xhigh-capable model."
		const before = pi.getThinkingLevel();
		setLevel("xhigh");
		const applied = pi.getThinkingLevel();
		if (applied !== "xhigh" && applied !== "max") {
			setLevel(before);
			ctx.ui.notify(`Ultracode runs at xhigh thinking, which ${model.id} doesn't support — switch to an xhigh-capable model.`, "error");
			return;
		}
		previousLevel = before;
		appliedLevel = applied;
		mode.enable();
		pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { action: "on", previousLevel });
		setBadge(ctx);
		ctx.ui.notify(`Set effort level to ultracode (this session only): ${applied} + dynamic workflow orchestration`, "info");
	};

	const disable = (ctx: ExtensionContext) => {
		if (!mode.isOn()) {
			ctx.ui.notify("Ultracode is not on.", "info");
			return;
		}
		mode.disable();
		// The keyword's opt-in-persistence path (before_agent_start, below) would
		// otherwise read this session's earlier "ultracode" keyword as proof the
		// opt-in still stands, and resurrect ENTER_SPARSE on the next background
		// workflow-result delivery — asserting the opposite of the off the user
		// just asked for. An explicit off wins over keyword history.
		keywordFiredThisSession = false;
		pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { action: "off" });
		if (previousLevel && previousLevel !== appliedLevel) {
			setLevel(previousLevel);
			ctx.ui.notify(`Ultracode off — thinking level restored to ${previousLevel}`, "info");
		} else {
			ctx.ui.notify("Ultracode off", "info");
		}
		previousLevel = undefined;
		appliedLevel = undefined;
		setBadge(ctx);
	};

	/** Live runs keyed by id, so the report can mix memory with the store. */
	const liveRuns = () => new Map(registry.all().map((run) => [run.progress.runId, run]));

	/** The runs the browsing surfaces show: this session's, newest first. */
	const listedRuns = () =>
		sessionRuns(listRuns(agentDir), sessionId, (runId) => registry.get(runId) !== undefined, sessionCwd);

	pi.registerCommand("workflows", {
		description: "Open the workflow control panel, or act on a run (/workflows pause|resume|cancel|show <id>)",
		// The completion shows the run's NAME and inserts its id: the subcommands
		// address runs by id, but nobody knows a run by `wf-mgk2j4l-1`. Matching
		// on either means `cancel code-rev` finds the run you mean and still
		// completes to something the handler can resolve.
		getArgumentCompletions: (prefix: string) => {
			const verbs = ["list", "show", "pause", "resume", "cancel"];
			const runs = listedRuns();
			// Labelled with the start time as well as the name, for the same reason
			// the panel rows carry it: five runs called `code-review` otherwise
			// produce five identical entries that each insert a different id, and
			// picking the wrong one cancels the wrong run.
			const now = Date.now();
			const options = [
				...verbs.map((verb) => ({ value: verb, label: verb })),
				...verbs.flatMap((verb) =>
					verb === "list"
						? []
						: runs.map((meta) => ({
								value: `${verb} ${meta.runId}`,
								label: `${verb} ${meta.name} (${startedLabel(meta.startedAt, now)})`,
							})),
				),
			];
			return options.filter((option) => option.value.startsWith(prefix) || option.label.startsWith(prefix));
		},
		handler: async (args: string, ctx) => {
			uiCtx = ctx;
			const [verb, target] = args.trim().split(/\s+/).filter(Boolean);

			if (!verb) {
				if (!ctx.hasUI) {
					ctx.ui.notify(statusReport(listedRuns(), liveRuns(), Date.now()), "info");
					return;
				}
				await openPanel(ctx);
				return;
			}

			if (verb === "list") {
				ctx.ui.notify(statusReport(listedRuns(), liveRuns(), Date.now()), "info");
				return;
			}

			if (verb === "cancel") {
				if (!target) {
					const count = registry.cancelAll();
					ctx.ui.notify(count > 0 ? `Cancelling ${count} workflow${count === 1 ? "" : "s"}` : "No running workflows.", "info");
					return;
				}
				const outcome = registry.cancel(target);
				if (outcome === "cancelled") ctx.ui.notify(`Cancelling ${target}`, "info");
				else if (outcome === "not-running") ctx.ui.notify(`${target} already finished.`, "info");
				else ctx.ui.notify(`${target} is not running in this session. /workflows list shows every run.`, "error");
				return;
			}

			if (verb === "pause" || verb === "resume") {
				if (!target) {
					ctx.ui.notify(`Usage: /workflows ${verb} <id>`, "error");
					return;
				}
				const outcome = verb === "pause" ? registry.pause(target) : registry.resume(target);
				if (outcome === "paused") ctx.ui.notify(`${target} pausing — in-flight agents finish, new ones wait.`, "info");
				else if (outcome === "resumed") ctx.ui.notify(`${target} resumed.`, "info");
				else if (outcome === "already") ctx.ui.notify(`${target} is already ${verb === "pause" ? "paused" : "running"}.`, "info");
				else if (outcome === "not-running") ctx.ui.notify(`${target} has finished.`, "info");
				else ctx.ui.notify(`${target} is not running in this session.`, "error");
				return;
			}

			if (verb === "show") {
				if (!target) {
					ctx.ui.notify("Usage: /workflows show <id>", "error");
					return;
				}
				const meta = readMeta(agentDir, target);
				if (!meta) {
					ctx.ui.notify(`No run ${target}. /workflows list shows this session's runs.`, "error");
					return;
				}
				const live = registry.get(target);
				const progress = live?.progress ?? progressFromJournal(meta, readJournalLines(agentDir, target));
				// `show` reads any id, including a run from another session that the
				// list no longer offers — you had to type the id to get here, and it
				// is how an interrupted run is inspected before being resumed. Said
				// out loud, because the run will not be in the list you just read.
				const foreign = !live && sessionId !== undefined && meta.sessionId !== sessionId;
				const lines = [
					// Name first — you already know the id, you typed it — with the id
					// kept at the end because this report is where you copy it from.
					`${meta.name} — ${meta.status}${meta.resumedFrom ? ` (resumed ${meta.resumedFrom})` : ""}  [${meta.runId}]`,
					// No cost, here or anywhere else under /workflows. The per-run
					// figure lives in /usage, which reports one row per run.
					`${meta.agentCount} agent(s), ${progress.replayedCount} replayed, ${meta.usage.turns} turns`,
					...(foreign ? ["(from another session — /workflows lists only this one)"] : []),
					`store: ${runDir(agentDir, target)}`,
					"",
					...allAgents(progress).map(
						(agent) => `  ${agent.status.padEnd(8)} ${agent.label}${agent.model ? ` · ${agent.model}` : ""}${agent.error ? ` · ${agent.error}` : ""}`,
					),
				];
				if (progress.error) lines.push("", progress.error);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify(`Invalid argument: ${verb}. Usage: /workflows [list|show|pause|resume|cancel [id]]`, "error");
		},
	});

	// The panel is advertised in the footer line directly under the prompt, so
	// reaching it should not need a typed command. shift+↓ keeps the "go to the
	// thing below" arrow while staying provably distinct from the bare ↓ the
	// editor uses for cursor and history (\x1b[B / \x1bOB decode as "down";
	// \x1b[1;2B / \x1b[b decode as "shift+down"), and nothing in pi binds it.
	//
	// The ctx is used and dropped, never stored as uiCtx: pi rebuilds it as a
	// plain object literal on every keypress, with none of the assertActive
	// getters that make a stale context throw — storing one would defeat the
	// catch in drawPanel that retires a dead context.
	//
	// No open-panel guard is needed. The gesture hangs off the editor, and while
	// the panel (or any other overlay:false component) holds the editor's slot
	// the editor is not the focused component, so the key never arrives.
	pi.registerShortcut("shift+down", {
		description: "Open the workflow control panel",
		handler: (ctx) => openPanel(ctx),
	});

	pi.registerCommand("ultracode", {
		description: "Toggle ultracode: xhigh thinking + standing workflow orchestration",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "status"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument === "" ) {
				if (mode.isOn()) disable(ctx);
				else enable(ctx);
				return;
			}
			if (argument === "on") return void enable(ctx);
			if (argument === "off") return void disable(ctx);
			if (argument === "status") {
				ctx.ui.notify(
					mode.isOn()
						? "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)"
						: "Ultracode is off. /ultracode to turn it on.",
					"info",
				);
				return;
			}
			ctx.ui.notify(`Invalid argument: ${argument}. Valid options are: on, off, status`, "error");
		},
	});
}
