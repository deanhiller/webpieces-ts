import { claudeEnv } from '@webpieces/rules-config';

import { L0_FAULT_SHIM_STALE, l0GuardHeader, l0MatrixCitation } from '../core/l0-fault-codes';
import { INSTALL_HOOKS_CMD, RESTORE_SHIM_CMD, UPGRADE_SHIM_CMD } from './l0-allowlist';
import { CODEX_READ_STILL_ALLOWED } from './l0-codex-read';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { NO_CHAINING_RULE, SHIM_MARKER } from './shim';

/**
 * THE FAIL-CLOSED DENY TEXT for a drifted managed hook surface (L0 fault S) — its own module because
 * shim.ts is at its line cap and this is one cohesive unit: the words a blocked agent reads, and
 * nothing else. It imports FROM shim.ts and is never imported BY it, so the graph stays acyclic.
 *
 * IT IS RENDERED IN THE HOUSE FORMAT, the same skeleton core/report.ts (formatReport) gives every L1
 * and L2 deny: a header naming what was blocked, a `[guard-name]` block listing the offenders with a
 * one-line `→ why`, what is still allowed, then numbered `Fix Option N:` lines each with its command
 * on its own line. L0 used to be the ONLY layer in webpieces that answered in one unbroken paragraph —
 * ~3,300 characters of it here — so the two commands that matter were buried in prose and there was no
 * guard name to grep for. Nothing about the DECISION changed; only the shape of the words.
 *
 * SHORTER IS NOT THE GOAL, SCANNABLE IS. The budget below still exists (a paragraph regrows when every
 * new finding argues its case here), but a section that earns a line gets a line.
 *
 * CONSTRAINT: the returned string must contain no `"` and no `\` — it is JSON-serialized by denyJson()
 * (a stray quote/backslash would corrupt the PreToolUse decision payload, not just the text). That is an
 * INVARIANT, not a hope, so every interpolated path is STRIPPED of both rather than trusted — a
 * Windows-style path or an odd directory name must not be able to corrupt the decision. Locked by unit
 * tests. An unusual root is also dropped from the `cd` cure rather than quoted (CD_PREFIX would reject it).
 *
 * NEWLINES ARE SAFE HERE AND NEEDED NO NEW MECHANISM. denyJson() runs JSON.stringify, which escapes a
 * real newline to the two-character `\n` on the wire, and Claude Code's parser turns it back. This is
 * already proven in production — every L1 deny is formatReport()'s multi-line string down this exact
 * path. The sh half of L0 (faults D/X/U/K in renderShim) cannot do this: it printf's REASON into a JSON
 * string literal, so it spells its newlines `${NL}` the same way it spells the ANSI escape `${ESC}`.
 * A real newline is neither a quote nor a backslash, so the JSON-safety assertions above are untouched.
 */
class ShimStaleDeny {
    private readonly installedVersion: string;
    /** The governing root, STRIPPED of `"` and `\` for display. '' when there is none to name. */
    private readonly safeRoot: string;
    /** CLAUDE_PROJECT_DIR as this process sees it, stripped the same way. */
    private readonly projectDir: string;
    private readonly drifted: readonly string[];
    private readonly inSubagent: boolean;
    /**
     * Whether the RAW root can carry a leading `cd <root> &&`. Tested against the raw root, never the
     * stripped one: stripping is a display-safety measure, and cd-anchoring to a path we just mangled
     * would prescribe a cd into a directory that does not exist. A root CD_PREFIX cannot express is
     * simply not offered as a `cd` (raw ok ⇒ safeRoot === root).
     */
    private readonly cdOk: boolean;

    constructor(installedVersion: string, root: string, drifted: readonly string[], inSubagent: boolean) {
        this.installedVersion = installedVersion;
        this.safeRoot = root.replace(/["\\]/g, '');
        this.projectDir = claudeEnv.projectDirForLog().replace(/["\\]/g, '');
        this.drifted = drifted;
        this.inSubagent = inSubagent;
        this.cdOk = root !== '' && /^[A-Za-z0-9._/@~+-]+$/.test(root);
    }

    render(): string {
        return [
            ...this.header(),
            ...this.measured(),
            ...this.caller(),
            ...this.stillAllowed(),
            ...this.fixOptions(),
            ...this.footer(),
        ].join('\n');
    }

    /**
     * `[managed-hook-surface]` and the surfaces that drifted, one per line.
     *
     * `drifted` names WHICH of the managed things moved — .claude/webpieces/ai-hook.sh, each harness's
     * .claude/settings.json hook registration, and its managed env entry (see hook-registration.ts). It
     * is REQUIRED, not optional: this used to be a shim-only message, and an optional list would let a
     * caller silently keep emitting the one-file text after the surface grew — the "two spellings of one
     * thing" shape the compatibility policy rejects. It was FOUR; guarantee-root.sh (L-1) is gone,
     * because the guard hooks are registered ABSOLUTE now and there is no second .sh to keep byte-locked.
     *
     * THE CAUSE IS A LIST. It used to assert flatly "(it was reverted or hand-edited)", which is
     * frequently FALSE — the common case is a shim whose logic simply predates this binary — and that
     * false certainty sent a real agent hunting for a tamper that never happened.
     */
    private header(): string[] {
        const verNote = this.installedVersion ? ` (installed version ${this.installedVersion})` : '';
        const n = this.drifted.length;
        const label = n === 1 ? '1 surface drifted' : `${String(n)} surfaces drifted`;
        return [
            '❌ webpieces ai-hooks blocked this call: a webpieces-managed hook surface no longer matches the installed guard binary.',
            '',
            l0GuardHeader(L0_FAULT_SHIM_STALE, label),
            ...this.drifted.map((surface: string): string => `  ${surface}`),
            `    → webpieces manages those THREE things as ONE set, GENERATED by the INSTALLED @webpieces/ai-hook-rules${verNote}; what is on disk is reverted, hand-edited, or predating this binary. The env entry is ${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE}, which pins the Bash cwd to the project root, identically for every subagent because settings env is inherited.`,
            `    → ${l0MatrixCitation(L0_FAULT_SHIM_STALE)}`,
            '',
        ];
    }

    /**
     * WHERE IT WAS MEASURED, in the deny itself and not only in the logs. #574 put `root=` and
     * `projectDir=` on every L1 invocation line (see decision-log / ClaudeEnv.projectDirForLog, whose
     * `<unset>` token keeps "variable absent" distinguishable from "set to empty"). The log is forensics
     * AFTER the fact; the deny is what a blocked agent reads IN the moment, and the absence of exactly
     * these two fields is what sent a real agent chasing the wrong mechanism for four cures. Same field
     * names on purpose, so the deny text and the log lines grep together.
     *
     * Agreement is the routine case; DISAGREEMENT is the signature of the session-root-vs-cwd split this
     * guard was rewritten to make unconstructible, so it gets said out loud rather than left to inference.
     */
    private measured(): string[] {
        if (this.safeRoot === '') return [];
        return [
            'Where this was measured:',
            `  root=${this.safeRoot} - the tree whose shim was compared, and the one to repair`,
            `  projectDir=${this.projectDir} - CLAUDE_PROJECT_DIR as this process sees it; <unset> = absent, not set-but-empty`,
            `    → ${this.verdict()}`,
            '',
        ];
    }

    private verdict(): string {
        return this.callerIsInTheTree()
            ? 'These two AGREE, so this is the ordinary case - the tree you are in is the tree being judged.'
            : 'These two DISAGREE - the tree being judged is NOT the one CLAUDE_PROJECT_DIR names, so cure the root= tree and do not assume your cwd is it.';
    }

    /** True when the tree needing repair is the caller's own tree — the input the caller branch gates on. */
    private callerIsInTheTree(): boolean {
        return this.safeRoot === this.projectDir;
    }

    /**
     * THE CALLER-GATED BRANCH. It changes the WORDS ONLY — never the block/allow decision, never which
     * command is printed, and never which tree anything acts on (that is decided from the path, which is
     * why the deleted AgentIdentity class is NOT coming back for anything but message shape; agent
     * identity was measured untrustworthy as a location signal when a worktree agent resumed on the
     * primary clone after its tree was reaped).
     *
     * Two inputs, both already on hand:
     *   1. `inSubagent` — from the payload's `agent_id`, which Claude Code populates ONLY off the main
     *      loop (main falls back to the session id, so the field is absent there). `agent_type` is NOT
     *      usable: it is always populated and discriminates nothing. REQUIRED for the same reason
     *      `drifted` is — an optional flag would let a caller keep emitting the main-loop text.
     *   2. root= vs projectDir= — different means the caller is not standing in the tree to repair.
     *
     * A main agent, and a subagent whose cwd IS the tree, get the cure and nothing else: they can run it,
     * see the result and commit it. A WORKTREE-ISOLATED subagent gets one extra step, and only because it
     * is true — MEASURED 2026-08-11: such an agent CAN run `cd <main> && pnpm exec wp-upgrade-shim` and it
     * works (the harness refuses cross-tree GIT operations, not this), but it can neither verify nor
     * commit the result, because `git -C <main>` is refused. So the escalation is of the COMMIT, not of
     * the repair, and the text must never tell it a local cure cannot work — the older wording asserted
     * exactly that and was false in the window where it fired (measured 2026-08-10: a worktree subagent
     * cured in place and the block lifted, with the deny's own root= naming that worktree).
     *
     * WHAT IS DELIBERATELY GONE: the "ask the coordinator to run pnpm install so both trees are on the
     * same @webpieces version" clause. Both hooks are registered ABSOLUTE, so every tree is already
     * judged by MAIN's shim and MAIN's binary — there is no version alignment left to ask for, and
     * asking sends an agent after a non-problem.
     */
    private caller(): string[] {
        // No governing root to name means no `Where this was measured` section either, so there is no
        // root= for this text to point at and nothing to escalate ABOUT. Silence beats a dangling field.
        if (this.safeRoot === '' || !this.inSubagent || this.callerIsInTheTree()) return [];
        return [
            'You are a SUBAGENT and root= is not the tree you are standing in, so this takes TWO steps:',
            '  1. Run Fix Option 1 below exactly as printed. It is already anchored to the tree that must change, and a worktree-isolated subagent CAN run it against another tree - that was measured and it works, so never conclude a local cure cannot work.',
            `  2. Then ESCALATE THE COMMIT, which is the part you cannot do: git -C ${this.safeRoot} is refused here, so you can neither verify nor commit what the cure regenerated. Tell the coordinator to run git status in ${this.safeRoot} and commit the regenerated shim.`,
            '',
        ];
    }

    private stillAllowed(): string[] {
        return [
            'Still allowed while this block is up:',
            `  - any Read, and ${CODEX_READ_STILL_ALLOWED}`,
            '  - any Write/Edit whose target is webpieces.config.json',
            '  - every command on the L0 allowlist, including both Fix Options below',
            '  THIS IS NOT A DEADLOCK: both options are explicitly ALLOWED through, so run one YOURSELF now - do not hand it back to the human. Every OTHER tool call is blocked until every managed surface matches again.',
            '',
        ];
    }

    /**
     * The two cures, house-numbered. ORDER IS LOAD-BEARING: wp-upgrade-shim LEADS because it is the only
     * cure that repairs every managed surface, it touches no config and imports only fs/path, so it
     * runs on a tree too broken to load the rule engine. The `cp` stays last as the pre-0.4.408 fallback.
     *
     * Both are anchored with a leading `cd <root> &&` when the root allows it — CD_PREFIX_*_ANCHORED
     * tolerates exactly that one prefix (locked by unit test), and it is what keeps the cure curable when
     * the AI's cwd is a DIFFERENT tree than the one being judged. OPTION 2 is a relative-path `cp`, so it
     * is even MORE cwd-sensitive than OPTION 1 — it is anchored too. Never a SECOND `cd … &&`: the
     * allowlist matches the whole command and three segments are denied.
     */
    private fixOptions(): string[] {
        const anchor = (cmd: string): string => (this.cdOk ? `cd ${this.safeRoot} && ${cmd}` : cmd);
        return [
            '  Fix Option 1: (preferred) the only cure that repairs every managed surface, and it runs on a broken tree',
            `    run EXACTLY: '${anchor(UPGRADE_SHIM_CMD)}'`,
            `  Fix Option 2: PARTIAL - repairs ${SHIM_MARKER} only. Pick it ONLY when the installed @webpieces/ai-hook-rules is older than 0.4.408, where Fix Option 1 does not exist yet; then upgrade and run Fix Option 1.`,
            `    run EXACTLY: '${anchor(RESTORE_SHIM_CMD)}'`,
            `  NOT an option: do NOT use the bare '${INSTALL_HOOKS_CMD}' here - it also migrates your config and PROMPTS for a hook target twice, which hangs a non-interactive session.`,
            '',
        ];
    }

    private footer(): string[] {
        return [
            NO_CHAINING_RULE,
            `If you meant to remove @webpieces/ai-hook-rules, delete its hooks from .claude/settings.json rather than reverting ${SHIM_MARKER}.`,
        ];
    }
}

// The ONE entry point its two call sites (hook-core's fault-S deny, and the L0 fault table in
// l0-matrix) import. The rendering lives on ShimStaleDeny above, per CLAUDE.md; this is the seam.
// webpieces-disable no-function-outside-class -- one-line constructor+render seam for ShimStaleDeny, in the dependency-free shim module (it must stay callable from a tree too broken to build a DI container).
export function shimStaleDenyReason(installedVersion: string, root: string, drifted: readonly string[], inSubagent: boolean): string {
    return new ShimStaleDeny(installedVersion, root, drifted, inSubagent).render();
}
