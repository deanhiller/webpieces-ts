import { claudeEnv } from '@webpieces/rules-config';

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
// `drifted` names WHICH of the three managed things moved — .claude/webpieces/ai-hook.sh, the
// .claude/settings.json hook registration, and its managed env entry
// CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR (see hook-registration.ts). It is REQUIRED, not optional:
// this used to be a shim-only message, and an optional list would let a caller silently keep emitting
// the one-file text after the surface grew — which is the "two spellings of one thing" shape the
// compatibility policy rejects.
//
// It was FOUR. guarantee-root.sh (L-1) is gone: the guard hooks are registered ABSOLUTE now, so the
// launch guarantee L-1 provided is structural and there is no second .sh file to keep byte-locked.
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
// THE MESSAGE DIET IS PART OF THE CONTRACT, and this deny is where it regresses. main landed a
// deliberate L0 message diet (384cdae) and blocks grow straight back into a wall of text when each new
// finding argues its case here; at eleven sections this one was ~4,000 chars, and `denyBudget` in
// shim-deny-reason.spec.ts now fails the build if it climbs back. Keep what CHANGES what the reader
// types (the two exact commands, that it is not a deadlock, the no-chaining rule, root=/projectDir=);
// cut what merely argues. What was cut and why:
//   - the "up to and including 0.4.588 OPTION 1 was inert, so EMPTY OUTPUT means it did not run"
//     paragraph. It was UNREACHABLE by construction: this text and `wp-upgrade-shim` ship in the SAME
//     package at the SAME version, so a binary new enough to print this sentence necessarily has the
//     process entry point 0.4.589 added. The incident is still recorded where it can bite —
//     bin-process-entry.spec.ts, which asserts the entry point exists.
//   - the "registered ABSOLUTE / a worktree borrows by walking up" aside. That is the DRIFT fault's
//     subject (WP_BORROW_NOTE in shim.ts) and it is restated in the guard-matrix doc this deny points at.
//   - "they are GENERATED and committed ... must NOT be reverted by hand", which said twice over what
//     the closing sentence already says once.
//
// CONSTRAINT: the returned string must contain no `"` and no `\` — it is JSON-serialized by denyJson()
// (a stray quote/backslash would corrupt the PreToolUse decision payload, not just the text). That is an
// INVARIANT, not a hope, so every interpolated path is STRIPPED of both rather than trusted — a
// Windows-style path or an odd directory name must not be able to corrupt the decision. Locked by unit
// tests. An unusual root is also dropped from the `cd` cure rather than quoted (CD_PREFIX would reject it).
//
// `inSubagent` comes from the PreToolUse payload's `agent_id`, which Claude Code delivers on stdin and
// populates ONLY off the main loop (main falls back to the session id, so the field is absent there).
// `agent_type` is NOT usable for this — it is always populated and discriminates nothing. It is a
// REQUIRED parameter for the same reason `drifted` is — an optional flag would let a caller keep
// emitting the main-loop text from a subagent, which is the case that most needs the extra line.
//
// THE SUBAGENT SENTENCE REASONS FROM root= vs projectDir=, IT DOES NOT ASSERT A FIXED CONCLUSION. It
// used to say flatly "the hooks resolve through CLAUDE_PROJECT_DIR, which names the MAIN tree, so a cure
// run only here CANNOT lift this block". That is a POST-FLIP fact stated during the PRE-FLIP window, and
// it is FALSE exactly when it fires: measured 2026-08-10, a worktree subagent hit fault S, ran OPTION 1
// in ITS OWN worktree, and the block lifted — because the registration still in force was the RELATIVE
// three-hook form, so the worktree's own ai-hook.sh ran against the worktree's own node_modules. The
// deny's own `root=` field named the worktree while the sentence insisted otherwise.
// WHICH tree to cure is already answered, for BOTH windows, by the root=/projectDir= verdict above:
// committedShimStale compares shimPath(root) and `root` is the tree the RUNNING binary came from, so
// repairing the root= tree clears the fault whichever registration form is live, and the cure is
// cd-anchored there. Telling an agent its cure cannot work, while it demonstrably can, costs more than
// saying nothing.
//
// SO THE SUBAGENT SENTENCE CARRIES THE PART THAT IS ACTUALLY SUBAGENT-SPECIFIC: there are TWO real
// cures and they fix different things. A — run the printed cure here; it works, and it makes THIS tree
// work NOW. B — a subagent cannot reach the main clone, so aligning the two trees is an ESCALATION
// ("ask the coordinator to run pnpm install in the main tree"), and that is what stops the trees
// disagreeing. Doing only A leaves the repo with two trees on two @webpieces releases — the live state
// on 2026-08-10, main clone on 0.4.616 while origin/main and three worktrees were on 0.4.624. And the
// rule it states is deliberately NOT "do not install in a worktree": a worktree NEEDS its own
// node_modules (nx, vitest and the eslint plugin all execute there and load from it). The rule is that
// its @webpieces must EQUAL the main tree's — the older WP_BORROW_NOTE wording got this backwards in
// both directions at different times.
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
        : 'These two DISAGREE - the tree being judged is NOT the one CLAUDE_PROJECT_DIR names, so cure the root= tree and do not assume your cwd is it.';
    const rootNote = safeRoot === '' ? '' : ` WHERE THIS WAS MEASURED: root=${safeRoot} (the tree whose shim was compared - the one to repair), projectDir=${projectDir} (CLAUDE_PROJECT_DIR as this process sees it; <unset> = absent, not set-but-empty). ${verdict}`;
    const upgrade = cdOk ? `cd ${safeRoot} && ${UPGRADE_SHIM_CMD}` : UPGRADE_SHIM_CMD;
    // OPTION 2 is a relative-path `cp`, so it is even MORE cwd-sensitive than OPTION 1 — anchor it too.
    const restore = cdOk ? `cd ${safeRoot} && ${RESTORE_SHIM_CMD}` : RESTORE_SHIM_CMD;
    // The subagent sentence goes BEFORE the options, so it is read before a cure is chosen rather than
    // after one has already been run in the wrong tree. WHICH tree is already answered by `verdict`
    // above, from root= vs projectDir=; this adds only what is specific to a subagent — that A and B are
    // BOTH real and fix different things, and that B is an ESCALATION because a subagent cannot reach
    // the main clone.
    const subagentNote = inSubagent
        ? ' YOU ARE RUNNING IN A SUBAGENT, so TWO cures are real and they fix DIFFERENT things: A makes THIS tree work now, B stops the two trees disagreeing. A - run the OPTION below exactly as printed; it is already anchored to the tree that must change, and running it from here DOES lift this block (measured), so never conclude a local cure cannot work. B - you cannot reach the main clone, so ESCALATE: ask the coordinator to run pnpm install in the main tree so both trees are on the same @webpieces version. A worktree NEEDS its own node_modules (nx, vitest and the eslint plugin all load from it); the rule is not no-install-here, it is that this tree @webpieces must EQUAL the main tree.'
        : '';
    return `❌ webpieces-managed hook surface was changed: ${what} no longer matches what the INSTALLED @webpieces/ai-hook-rules${verNote} expects (reverted, hand-edited, or predating this binary).${rootNote} webpieces manages THREE things and they only work as a set: ${SHIM_MARKER} (the guard shim), the .claude/settings.json entries that register it, and the .claude/settings.json env entry ${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE} (which pins the Bash cwd to the project root, identically for every subagent because settings env is inherited). Every OTHER tool call is blocked until all three match again.${subagentNote} THIS IS NOT A DEADLOCK: both options below are explicitly ALLOWED through while this guard is up, so run one YOURSELF now - do not hand it back to the human. OPTION 1 (preferred - the only one that repairs all three, and it runs on a broken tree) - run EXACTLY this command: '${upgrade}'. OPTION 2 (PARTIAL - repairs ${SHIM_MARKER} only; pick it ONLY when the installed @webpieces/ai-hook-rules is older than 0.4.408, where OPTION 1 does not exist yet, then upgrade and run OPTION 1) - run EXACTLY this command: '${restore}'. Do NOT use the bare '${INSTALL_HOOKS_CMD}' here: it also migrates your config and PROMPTS for a hook target twice, which hangs a non-interactive session. ${NO_CHAINING_RULE} If you meant to remove @webpieces/ai-hook-rules, delete its hooks from .claude/settings.json rather than reverting these files.`;
}
