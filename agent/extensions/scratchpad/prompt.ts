/**
 * What the agent is told about its scratchpad. Pure.
 *
 * The feature is one mkdir and a paragraph, and the paragraph is the part that
 * decides whether it works. A directory the model does not know to prefer is a
 * directory it does not use — it will keep reaching for `/tmp/x.ts` and the
 * repo it is standing in, because those are what everything it ever read did.
 *
 * So the text is written to beat that habit specifically:
 *
 *   - it names the absolute path, because a model cannot use a path it has to
 *     guess, and a relative one lands wherever cwd happens to be;
 *   - it says what goes there in the concrete terms the cases actually arrive
 *     in ("a script to check something", "a big command's output") rather than
 *     the abstract "temporary files", which reads as "files I have decided are
 *     temporary" and matches almost nothing;
 *   - it gives the reason, once. A rule with a reason survives contact with a
 *     situation its author did not foresee; a bare instruction does not.
 *   - it names the escape hatch, so "the user asked for /tmp" does not turn
 *     into a rule conflict the model resolves by ignoring one of them.
 */

/**
 * The block appended to the system prompt.
 *
 * Deliberately short. It competes for attention with everything else in a system
 * prompt, and a wall of text about temp files earns less compliance than four
 * lines that are impossible to misread.
 */
export function scratchpadPrompt(dir: string): string {
	return [
		"# Scratchpad",
		"",
		`Working directory for files that are not part of the user's project: ${dir}`,
		"",
		"Put scratch work there rather than in the project or in /tmp: throwaway scripts, a big command's output you want to grep, intermediate results, notes to yourself across several steps, anything you would otherwise name `tmp.ts` or `test.json`.",
		"",
		"The reason is that the project is usually a git repository. A stray file there shows up in `git status`, gets swept in by a directory-wide `git add`, and can end up committed and pushed. The scratchpad is outside every repository, private to this session, and already writable — so using it costs nothing and needs no permission.",
		"",
		"Use /tmp or the project itself only when the user asks for a file in a specific place.",
	].join("\n");
}
