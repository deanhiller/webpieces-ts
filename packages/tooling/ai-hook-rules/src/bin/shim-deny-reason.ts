import { claudeEnv } from '@webpieces/rules-config';

import { GUARANTEE_ROOT_MARKER } from './guarantee-root';
import { INSTALL_HOOKS_CMD, RESTORE_SHIM_CMD, UPGRADE_SHIM_CMD } from './l0-allowlist';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { NO_CHAINING_RULE, SHIM_MARKER } from './shim';

/**
 * THE FAIL-CLOSED DENY TEXT for a drifted managed hook surface (L0 fault S) — its own module because
 * shim.ts is at its line cap and this is one cohesive unit: the words a blocked agent reads, and
 * nothing else. It imports FROM shim.ts and is never imported BY it, so the graph stays acyclic.
 */
// The fail-closed deny text for a drifted MANAGED HOOK SURFACE, built from the single-source cure
// constants + NO_CHAINING_RULE.
//
// `drifted` names WHICH of the four managed things moved — .claude/webpieces/ai-hook.sh,
// .claude/webpieces/guarantee-root.sh, the .claude/settings.json hook registration, and its managed
// env entry CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR (see hook-registration.ts). It is REQUIRED, not
// optional: this used to be a shim-only message, and an optional list would let a caller silently keep
// emitting the one-file text after the surface grew to four — which is the "two spellings of one
// thing" shape the compatibility policy rejects.
//
// `installedVersion` names WHICH webpieces the cure re-arms to (the binary is that
// version); pass '' to omit the note rather than print an empty one. `root` is the tree the deciding
// binary GOVERNS (governingShimRoot) — naming it, and anchoring the cure to it with a leading
// `cd <root> &&` (which CD_PREFIX_*_ANCHORED already tolerates, locked by a unit test), is what keeps
// the cure curable when the AI's cwd is a DIFFERENT tree than the one being judged. Pass '' to omit.
//
// The cause list is deliberately a LIST: it used to assert flatly "(it was reverted or hand-edited)",
// which is frequently FALSE — the common case is a shim whose logic simply predates this binary — and
// that false certainty sent a real agent hunting for a tamper that never happened.
//
// WHERE IT WAS MEASURED, in the deny itself and not only in the logs. #574 put `root=` and
// `projectDir=` on every L1 invocation line (see decision-log / ClaudeEnv.projectDirForLog, whose
// `<unset>` token keeps "variable absent" distinguishable from "set to empty"). The log is forensics
// AFTER the fact; the deny is what a blocked agent reads IN the moment, and the absence of exactly
// these two fields is what sent a real agent chasing the wrong mechanism for four cures. Same field
// names on purpose, so the deny text and the log lines grep together.
//
// CONSTRAINT: the returned string must contain no `"` and no `\` — it is JSON-serialized by denyJson()
// (a stray quote/backslash would corrupt the PreToolUse decision payload, not just the text). That is an
// INVARIANT, not a hope, so every interpolated path is STRIPPED of both rather than trusted — a
// Windows-style path or an odd directory name must not be able to corrupt the decision. Locked by unit
// tests. An unusual root is also dropped from the `cd` cure rather than quoted (CD_PREFIX would reject it).
//
// `inSubagent` comes from the PreToolUse payload's `agent_id`, which Claude Code delivers on stdin and
// populates ONLY off the main loop (main falls back to the session id, so the field is absent there).
// `agent_type` is NOT usable for this — it is always populated and discriminates nothing. A subagent
// needs one extra sentence, because the hooks that are blocking it resolve through $CLAUDE_PROJECT_DIR,
// which names the MAIN tree: a cure run only in its own worktree cannot lift the block. It is a
// REQUIRED parameter for the same reason `drifted` is — an optional flag would let a caller keep
// emitting the main-loop text from a subagent, which is the case that most needs the extra line.
// webpieces-disable no-function-outside-class -- pure string builder over exported constants; the single source of the self-guard deny text now that the sh copy is gone.
export function shimStaleDenyReason(installedVersion: string, root: string, drifted: readonly string[], inSubagent: boolean): string {
    const verNote = installedVersion ? ` (installed version ${installedVersion})` : '';
    const what = drifted.join(', ');
    const safeRoot = root.replace(/["\\]/g, '');
    const projectDir = claudeEnv.projectDirForLog().replace(/["\\]/g, '');
    // Tested against the RAW root, never the stripped one: stripping is a display-safety measure, and
    // cd-anchoring to a path we just mangled would prescribe a cd into a directory that does not exist.
    // A root CD_PREFIX cannot express is simply not offered as a `cd` (raw ok ⇒ safeRoot === root).
    const cdOk = root !== '' && /^[A-Za-z0-9._/@~+-]+$/.test(root);
    // Agreement is the routine case; DISAGREEMENT is the signature of the session-root-vs-cwd split this
    // guard was rewritten to make unconstructible, so it gets said out loud rather than left to inference.
    const verdict = safeRoot === projectDir
        ? 'These two AGREE, so this is the ordinary case - the tree you are in is the tree being judged.'
        : 'These two DISAGREE - the tree being judged is NOT the one CLAUDE_PROJECT_DIR names, so cure the root= tree specifically and do not assume your current directory is it.';
    const rootNote = safeRoot === '' ? '' : ` WHERE THIS WAS MEASURED: root=${safeRoot} (the tree the RUNNING guard binary itself came from - that is the tree whose shim must change), projectDir=${projectDir} (CLAUDE_PROJECT_DIR as this process sees it; <unset> means the variable is absent, which is not the same as set-but-empty). ${verdict}`;
    const upgrade = cdOk ? `cd ${safeRoot} && ${UPGRADE_SHIM_CMD}` : UPGRADE_SHIM_CMD;
    // OPTION 2 is a relative-path `cp`, so it is even MORE cwd-sensitive than OPTION 1 — anchor it too.
    const restore = cdOk ? `cd ${safeRoot} && ${RESTORE_SHIM_CMD}` : RESTORE_SHIM_CMD;
    // The subagent sentence goes BEFORE the options, so it is read before a cure is chosen rather than
    // after one has already been run in the wrong tree.
    const subagentNote = inSubagent
        ? ' YOU ARE RUNNING IN A SUBAGENT: the hooks blocking you resolve through CLAUDE_PROJECT_DIR, which names the MAIN tree and not yours, so a cure run only here CANNOT lift this block - the MAIN tree is where pnpm install and the repair have to happen, because the hooks execute the release INSTALLED IN THAT TREE, not the one in this worktree. Running the repair in THIS worktree afterwards is also correct and is the aligned end state: it is what makes this tree right once its own branch is the one being judged.'
        : '';
    return `❌ webpieces-managed hook surface was changed: ${what} no longer matches what the INSTALLED @webpieces/ai-hook-rules${verNote} expects (reverted, hand-edited, or predating this binary - a settings.json still on the OLD two-absolute-hook form reports here too).${rootNote} webpieces manages FOUR things together and they only work as a set: ${SHIM_MARKER} (the guard shim, registered RELATIVE so each git tree runs its own release), ${GUARANTEE_ROOT_MARKER} (the L-1 hook, registered ABSOLUTE, which refuses any cd that would park the shell where the relative hooks cannot launch - without it an unresolvable hook is a SILENT UNGUARDED ALLOW), the .claude/settings.json entries that register them, and the .claude/settings.json env entry ${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE} (which pins the Bash cwd to the project root so those RELATIVE entries always resolve - and, because settings env is inherited, pins it identically for every subagent). They are GENERATED and committed by webpieces - they must NOT be reverted or edited by hand, and the fail-closed logic cannot be trusted while any of them differs. Every OTHER tool call is blocked until all four match again. ${subagentNote} THIS IS NOT A DEADLOCK: both options below are explicitly ALLOWED through while this guard is up, so run one YOURSELF now - do not hand it back to the human. OPTION 1 (preferred, and the ONLY option that repairs all four - it regenerates both .sh files, rewrites the settings.json registration to the three-hook form, removing the old absolute entries, AND sets the managed env entry; it touches no config, and it imports only fs/path so it runs on a broken tree; needs installed @webpieces/ai-hook-rules 0.4.408 or newer) - run EXACTLY this command: '${upgrade}'. HOW TO TELL OPTION 1 WORKED, because up to and including 0.4.588 it silently did NOTHING (it had no process entry point, so it printed nothing and exited 0 - which is why this guard could look like a deadlock): a working OPTION 1 PRINTS a line per repaired surface and re-checks all four afterwards, exiting NON-ZERO and naming whatever still differs. So EMPTY OUTPUT means the cure did not run at all - do not re-run it in a loop; upgrade @webpieces/ai-hook-rules, use OPTION 2 for the shim, and say plainly that OPTION 1 is inert in this release. OPTION 2 (a PARTIAL fallback - it repairs ONE of the four, ${SHIM_MARKER}, and nothing else; pick it only when the installed @webpieces/ai-hook-rules is OLDER than 0.4.408 so wp-upgrade-shim does not exist yet, then upgrade @webpieces and run OPTION 1 to finish the job. Claude Code's own permission prompt may ask you to confirm the file overwrite, and that prompt is NOT this guard) - run EXACTLY this command: '${restore}'. Do NOT use the bare '${INSTALL_HOOKS_CMD}' here: it also migrates your config and PROMPTS for a hook target twice, which hangs a non-interactive session. ${NO_CHAINING_RULE} Do NOT revert these files again - if you meant to remove @webpieces/ai-hook-rules, delete its hooks from .claude/settings.json instead.`;
}
