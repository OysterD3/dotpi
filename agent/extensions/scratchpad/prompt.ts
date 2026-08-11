/**
 * What the model is told about the scratchpad.
 *
 * ## What a scratchpad is for
 *
 * An agent working on a real task produces files nobody asked for: the JSON it
 * dumped to look at a shape, the throwaway script that reproduced the bug, the
 * two hundred lines of `pytest -v` output it wanted to grep twice, the copy of a
 * config it edited before deciding not to. Every one of those has to go
 * somewhere, and with nowhere named, there are exactly two places it goes, both
 * bad:
 *
 *   The repository. Now `git status` has eleven untracked files in it, the diff
 *   the user is reviewing is full of `tmp2.py`, and the odds that one of them
 *   gets swept into a commit are not zero. This is the failure that actually
 *   costs something, because it lands in the user's history.
 *
 *   Bare `/tmp`. Shared with every process and every other session on the
 *   machine, so `/tmp/output.json` is a name two concurrent pi sessions will
 *   both pick, and the second one silently wins. Nothing is scoped to anything,
 *   and nothing gets cleaned up in any way you can predict.
 *
 * A scratchpad is the third place: a directory that exists before the model
 * needs it, is unique to this session so nothing collides, sits outside the
 * project so nothing pollutes a diff, and is pre-approved so writing there never
 * stops to ask. That last property is the one that changes behaviour rather than
 * just tidiness — a model that expects a prompt for every scratch file writes
 * fewer of them, and does the multi-step work in its head instead of on disk.
 *
 * ## Why it is worded the way it is
 *
 * Both blocks are imperative and state the path absolutely, because "you may use
 * this directory" gets read as an offer and declined. "The directory already
 * exists" is there to save an `mkdir -p` round trip. The `/tmp` escape hatch is
 * explicit so a user who genuinely wants a file in `/tmp` can still ask for one
 * and get it.
 *
 * ## Why this is split in two
 *
 * The long version used to be the system-prompt block, which meant paying for
 * every line of it on every request of the session — used or not, and a session
 * that never writes a scratch file pays exactly as much as one that writes
 * twenty. That is the standing cost `skill-loading` exists to argue about, and
 * the same argument applies here.
 *
 * So the request carries the SHORT block and the `scratchpad` tool returns the
 * long one on demand. What stays inline is only what changes behaviour when the
 * model has not asked: the path, that the directory already exists, and that
 * writes are pre-approved — a model that expects a permission prompt for every
 * scratch file writes fewer of them, and that is true whether or not it ever
 * calls the tool. Everything else is detail the model can fetch when it is
 * actually about to write something.
 *
 * Removing the block entirely was the other option and is worse: nothing would
 * tell the model a scratchpad exists, so it would fall back to `/tmp` or the
 * user's project without ever discovering the tool — the exact failure this
 * extension was built to stop.
 *
 * Appended in `before_agent_start`, after pi's own system prompt, the way
 * add-dir appends its directory list — so it is cached across the turn rather
 * than resent as a message, and it does not disturb prompt caching because the
 * path is fixed for the whole session (including across a resume, since the
 * session id is what names it).
 *
 * Pure: string transforms, so the exact bytes that reach the model are directly
 * testable.
 */

/**
 * The short block appended to pi's system prompt on every request.
 *
 * Every claim in here is one the model acts on without being asked. Anything
 * that only matters once it has already decided to write a file belongs in
 * `buildToolGuidance` instead, where it is paid for only when fetched.
 */
export function buildPromptBlock(dir: string): string {
	return `

# Scratchpad Directory

IMPORTANT: Always use this directory for temporary files, instead of \`/tmp\` or the user's project:
\`${dir}\`

It already exists (no \`mkdir\`) and writes to it are pre-approved (no permission prompt). Call the \`scratchpad\` tool for the full rules and current contents.`;
}

/**
 * The long version, returned by the `scratchpad` tool rather than carried in
 * every request. Repeats the path so the result stands on its own in the
 * transcript: the model may be reading this many turns after the block above
 * scrolled out of its attention.
 */
export function buildToolGuidance(dir: string): string {
	return `Scratchpad directory for this session:
\`${dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing throwaway scripts, reproductions, or configuration files
- Saving command output you want to search or re-read later in the turn
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\` or be left lying in the user's project

The directory already exists — write into it directly, with no \`mkdir\` first. It is specific to this session, so it never collides with another session working on the same project; it is outside the user's project, so nothing you put there shows up in their diff or gets committed by accident; and writes to it are pre-approved, so they never raise a permission prompt.

Only put temporary files in \`/tmp\` or in the working directory if the user explicitly asks for them there.`;
}
