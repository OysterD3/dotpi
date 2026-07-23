/**
 * The workflow tool's LLM-facing description: Claude Code's Workflow tool
 * description, cut to the features this port implements (no resume, no
 * worktree isolation, no nested workflow(), no budget directive) and with the
 * same Ultracode section the reminder texts reference. Assembled by
 * workflowDescription() so the user's model-routing policy is embedded when
 * configured.
 */

const CORE = `Execute a workflow script that orchestrates multiple subagents deterministically. Each agent is a fresh headless pi run in this project directory with the standard tools (read, bash, edit, write); agents cannot spawn further workflows.

Workflows run in the BACKGROUND: this call validates the script, starts the fleet, and returns immediately with a run id. A "workflow-result" message arrives when the run completes — NEVER fabricate or predict a pending run's results; continue with other work or end the turn and wait. The user watches progress in the status panel and can cancel via /workflows. Pass wait: true only when the result is needed before you can do anything else.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script encodes that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** below.
- The user directly asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents").

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool; briefly describe what a workflow could do and ask.

**Ultracode.** When a system-reminder says ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint. For multi-phase work (understand → design → implement → review) run several workflows in sequence, one per phase, so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule above.

Every script must begin with \`export const meta = {...}\` — a PURE object literal (no variables, calls, or interpolation) with required string fields \`name\` and \`description\`, and optionally \`phases: [{ title, detail? }]\`.

Script body hooks (plain JavaScript, NOT TypeScript; the body runs in an async context — use await and top-level return):
- agent(prompt, opts?): Promise<any> — spawn a subagent; returns its final text. opts: {label?, phase?, model?, thinking? ("low"|"medium"|"high"|"xhigh"|"max"), schema?}. model is a REFERENCE resolved like pi's --model: "provider/id", a bare id, or a distinctive partial name ("sonnet", "fable", "haiku") — an ambiguous or unknown reference fails that agent with a clear error, so prefer distinctive names. With schema (a JSON Schema object), the subagent is told to reply with ONLY matching JSON and agent() returns the parsed value, retrying once on unusable output. On failure agent() returns null (filter with .filter(Boolean)).
- parallel(thunks): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks. A thunk that throws resolves to null — the call itself never rejects.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Every stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to null and skips its remaining stages.
- phase(title): void — group subsequent agents under this title in progress output.
- log(message): void — emit a progress line.
- args: any — the value passed as this tool's \`args\` input, verbatim.
- budget: {total: null, spent(), remaining()} — compatibility stub; total is always null and remaining() Infinity, so budget-guarded loops written for other harnesses fall through cleanly.

Limits: concurrent agents capped at min(16, cores - 2) (excess queue); 1000 agents per run; 4096 items per parallel()/pipeline() call; each agent has a 10-minute wall-clock ceiling. Nested workflow() throws. There is no resume: a failed run re-runs from the top, so prefer several small workflows over one giant one. The script body runs on the host event loop: always await — a synchronous busy-wait loop freezes the whole session.

DEFAULT TO pipeline(). A barrier (parallel between stages) is correct ONLY when stage N needs cross-item context from all of stage N-1 — dedup/merge across the full result set, early-exit on a zero count, or a prompt that references "the other findings". "The stages are conceptually separate" is not a reason; barrier latency is real.

The canonical multi-stage pattern — each dimension verifies as soon as its review completes:
  export const meta = { name: 'review', description: 'review then verify', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
    review => parallel((review?.findings ?? []).map(f => () =>
      agent('Adversarially verify: ' + f.title, { phase: 'Verify', schema: VERDICT_SCHEMA }).then(v => ({ ...f, verdict: v }))))
  )
  return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)

Quality patterns — compose freely:
- Adversarial verify: N independent skeptics per finding, each prompted to REFUTE; kill if a majority refute. Prevents plausible-but-wrong findings from surviving.
- Perspective-diverse verify: give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters.
- Judge panel: N independent attempts from different angles, parallel judges score, synthesize from the winner.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K consecutive rounds return nothing new; dedup against everything seen in plain code, not an agent.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time); useful when one search angle won't find everything.
- Completeness critic: a final agent asking "what's missing?" — its findings become the next round.
- No silent caps: if the script bounds coverage (top-N, sampling), log() what was dropped.

Scale to what the user asked for: "find any bugs" → a few finders, single-vote verify; "thoroughly audit" → larger pool, 3-5 vote adversarial pass, synthesis stage. Subagents are told their final text is machine-consumed — prompt them to return raw data, not prose for humans.`;

/** Assemble the description, embedding the user's routing policy if set. */
export function workflowDescription(modelPolicy?: string): string {
	if (!modelPolicy?.trim()) return CORE;
	return `${CORE}

**Model routing (user policy).** The user has a standing policy for which models workflow subagents use: "${modelPolicy.trim()}". Honor it when authoring scripts: give each agent whose role the policy covers a matching model reference via opts.model (e.g. { model: "sonnet" } for an implementation agent, { model: "fable" } for a reviewer). Roles the policy does not cover use the default subagent model.`;
}

export const WORKFLOW_PROMPT_SNIPPET =
	"workflow: orchestrate fleets of subagents from a script, in the background (requires explicit user opt-in, e.g. the ultracode keyword)";

/** Appended to every subagent prompt so replies come back as data. */
export const SUBAGENT_PREAMBLE =
	"You are a subagent in a deterministic workflow. Your final message is consumed by a script, not read by a person: return the requested data directly, with no preamble and no offers of further help.\n\n";
