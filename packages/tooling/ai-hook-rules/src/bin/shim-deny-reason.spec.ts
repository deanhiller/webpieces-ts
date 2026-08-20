import { describe, it, expect } from 'vitest';

import { CLAUDE_PROJECT_DIR_ENV } from '@webpieces/rules-config';

import { GUARD_MATRIX_DOC, guardMatrixPointer } from '../core/l0-matrix';
import { L0_FAULT_NAMES, L0_FAULT_SHIM_STALE, L0_ROW_BLOCKED } from '../core/l0-fault-codes';
import { renderL1Doc } from '../core/l1-doc';
import { renderVersionSyncRow8Report } from '../core/version-sync.spec';
import { shimStaleDenyReason } from './shim-deny-reason';
import { INSTALL_HOOKS_CMD, NO_CHAINING_RULE, RESTORE_SHIM_CMD, SHIM_MARKER, UPGRADE_SHIM_CMD, renderShim } from './shim';
import { ENV_SURFACE, REGISTRATION_SURFACE } from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';

/**
 * HOW the self-guard's deny SPELLS its cures. Two numbered `Fix Option N:` lines — the HOUSE FORMAT
 * core/report.ts gives every L1/L2 deny — each with its command quoted on its own line, plus
 * NO_CHAINING_RULE (see its audit-log origin). The ORDER is load-bearing: `wp-upgrade-shim` LEADS
 * because it is the only cure that repairs ALL THREE managed surfaces — ai-hook.sh, the settings.json
 * registration and the managed env entry — and it also deletes the retired guarantee-root.sh, while
 * still touching NO config and importing only fs/path, so it runs on a broken
 * tree. (It has not been shim-only since 2026-08-07; the bin's NAME is older than its job and is
 * deliberately not renamed.) The `cp` stays last, as the pre-0.4.408 fallback for the releases where
 * wp-upgrade-shim does not exist yet, and it repairs ONE of the three. The installer is NOT an option
 * here at all — it would also migrate the config and prompt twice. The string must be JSON-safe — no
 * `"` / `\` — since denyJson() serializes it.
 */
describe('shimStaleDenyReason — unambiguous, JSON-safe, not a deadlock', () => {
    const reason = shimStaleDenyReason('0.4.431', '', [SHIM_MARKER], false);

    it('offers both cures, quoted EXACTLY, wp-upgrade-shim first and the cp last, with the version note', () => {
        expect(reason).toContain('installed version 0.4.431');
        expect(reason).toContain('Fix Option 1: (preferred)');
        expect(reason).toContain('Fix Option 2: PARTIAL');
        for (const cmd of [UPGRADE_SHIM_CMD, RESTORE_SHIM_CMD]) {
            expect(reason).toContain(`\n    run EXACTLY: '${cmd}'`);
        }
        expect(reason.indexOf(UPGRADE_SHIM_CMD)).toBeLessThan(reason.indexOf(RESTORE_SHIM_CMD));
    });

    /**
     * THE HOUSE FORMAT, asserted as a shape rather than as prose. L0 was the ONLY layer in webpieces
     * answering in one unbroken paragraph; these four lines are what "it is in the house format now"
     * means, and they are what a future edit would silently undo by collapsing a section back into a
     * sentence. The skeleton is copied from core/report.ts (formatReport), not invented here.
     */
    it('renders in the house skeleton: header, [guard-name] block, → why, numbered Fix Options', () => {
        const lines = reason.split('\n');
        expect(lines.length).toBeGreaterThan(10);              // it is a SHAPE, not a paragraph
        expect(lines[0]).toContain('❌ webpieces ai-hooks blocked this call:');
        expect(lines[2]).toBe('[managed-hook-surface] (layer=L0 fault=S row=3, 1 surface drifted)');
        expect(lines[3]).toBe(`  ${SHIM_MARKER}`);             // the offender, indented under its guard
        expect(lines[4].startsWith('    → ')).toBe(true);      // ...and exactly one sentence of why
        expect(reason).toContain('\nStill allowed while this block is up:');
    });

    /**
     * THE THREE-WAY JOIN. One event, three artifacts — the deny read in the moment, the audit line, and
     * the matrix doc — and until now they shared no coordinate at all: the deny named no guard, no fault
     * letter and no row, so a transcript could not be debugged against the log after the fact.
     *
     * The deny now carries the SAME `layer=` / `fault=` / `row=` triple the audit line carries (see
     * MATRIX_L0_BLOCK in decision-log.ts) and the same guard name the doc's `guard` column prints, all
     * from the one vocabulary in core/l0-fault-codes.ts. The full join is asserted across all three
     * artifacts in l0-matrix.spec.ts; this pins the deny's half of it.
     */
    it('carries the guard name and the log/doc coordinates, so one grep spans all three artifacts', () => {
        expect(reason).toContain(`[${L0_FAULT_NAMES[L0_FAULT_SHIM_STALE]}]`);
        expect(reason).toContain(`layer=L0 fault=${L0_FAULT_SHIM_STALE} row=${L0_ROW_BLOCKED}`);
        expect(reason).toContain(`matrix row ${L0_ROW_BLOCKED}:`);
        expect(reason).toContain(`the audit line carries (layer=L0 row=${L0_ROW_BLOCKED} fault=${L0_FAULT_SHIM_STALE})`);
    });

    /** Plural agreement in the count, the same way formatReport says "1 violation" / "N violations". */
    it('counts the drifted surfaces, singular and plural', () => {
        expect(shimStaleDenyReason('', '', [SHIM_MARKER], false)).toContain('1 surface drifted');
        expect(shimStaleDenyReason('', '', [SHIM_MARKER, REGISTRATION_SURFACE, ENV_SURFACE], false))
            .toContain('3 surfaces drifted');
    });

    // The installer is named ONLY to warn against it. An agent that runs it here waits forever on a
    // prompt it cannot see, and reports the guard as a deadlock.
    it('warns off the installer, which prompts twice and hangs a non-interactive session', () => {
        expect(reason).toContain(`do NOT use the bare '${INSTALL_HOOKS_CMD}' here`);
        expect(reason).toContain('PROMPTS for a hook target twice');
    });

    it('carries the no-chaining rule and states plainly it is NOT a deadlock', () => {
        expect(reason).toContain(NO_CHAINING_RULE);
        expect(reason).toContain('appending anything (even && git status)');
        expect(reason).toContain('NOT A DEADLOCK');
        expect(reason).toContain('ALLOWED');
        expect(reason).not.toContain('Every tool call is blocked'); // the unqualified claim that read as deadlock
    });

    it('omits the version note (no empty parens) when the installed version is unknown', () => {
        const r = shimStaleDenyReason('', '', [SHIM_MARKER], false);
        expect(r).not.toContain('installed version )');
        expect(r).not.toContain('()');
        expect(r).toContain(UPGRADE_SHIM_CMD); // the cure survives an unreadable version
    });

    it('contains no double-quote or backslash (either would corrupt the PreToolUse decision JSON)', () => {
        expect(reason).not.toContain('"');
        expect(reason).not.toContain('\\');
    });

    // The deny must TEACH the surface it is judging, or a blocked agent repairs three of four and
    // reports success — the failure mode upgrade-shim.ts's header exists to prevent.
    it('names all three managed things, including the env entry and why it exists', () => {
        expect(reason).toContain('THREE things');
        expect(reason).not.toContain('FOUR things');
        expect(reason).toContain(`${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE}`);
        expect(reason).toContain('pins the Bash cwd to the project root');
        expect(reason).toContain('inherited');
        expect(reason).toContain('repairs all three');
    });

    /**
     * THE CALLER-GATED CURE BRANCH — three cases, and the message is the ONLY thing that varies.
     *
     * Inputs: `inSubagent` (from the payload's `agent_id`, which Claude Code populates only off the main
     * loop — `agent_type` is NOT usable, it is always populated), and root= vs projectDir=. Identity is
     * used for MESSAGE SHAPE and nothing else; WHICH tree anything acts on is decided from the path,
     * because a worktree agent was measured resuming on the primary clone after its tree was reaped.
     *
     * A main agent, and a subagent already standing in the tree that needs repair, both get the plain
     * cure: they can run it, see the result and commit it, so there is nothing to escalate. Only the
     * worktree-ISOLATED subagent gets the extra step.
     */
    it('says nothing extra to a main agent, or to a subagent already in the tree to repair', () => {
        const original = process.env[CLAUDE_PROJECT_DIR_ENV];
        // webpieces-disable no-unmanaged-exceptions -- try/FINALLY only (no catch): a failing expect must not leak an env var into the rest of the suite.
        try {
            process.env[CLAUDE_PROJECT_DIR_ENV] = '/tmp/wp-tree';
            const mainAgent = shimStaleDenyReason('0.4.431', '/tmp/wp-tree', [SHIM_MARKER], false);
            const subInTree = shimStaleDenyReason('0.4.431', '/tmp/wp-tree', [SHIM_MARKER], true);
            for (const text of [mainAgent, subInTree]) {
                expect(text).not.toContain('SUBAGENT');
                expect(text).not.toContain('ESCALATE');
                expect(text).toContain(`run EXACTLY: 'cd /tmp/wp-tree && ${UPGRADE_SHIM_CMD}'`);
            }
        } finally {
            if (original === undefined) delete process.env[CLAUDE_PROJECT_DIR_ENV];
            else process.env[CLAUDE_PROJECT_DIR_ENV] = original;
        }
    });

    /**
     * THE WORKTREE-ISOLATED SUBAGENT — run the cure, THEN escalate the COMMIT. Both halves are MEASURED,
     * and the message must not overstate either.
     *
     * It CAN run `cd <other tree> && pnpm exec wp-upgrade-shim`: the harness refuses cross-tree GIT
     * operations, not this (measured 2026-08-11). So the text must never tell it a local cure cannot
     * work — the older wording asserted exactly that and was false in the window where it fired
     * (measured 2026-08-10: a worktree subagent cured in place and the block lifted, with the deny's own
     * root= naming that worktree).
     *
     * What it CANNOT do is verify or commit the result, because `git -C <other tree>` is refused. That,
     * and only that, is the escalation.
     *
     * WHAT IS DELIBERATELY GONE: "ask the coordinator to run pnpm install so both trees are on the same
     * @webpieces version". Both hooks are registered ABSOLUTE, so every tree is already judged by MAIN's
     * shim and MAIN's binary — there is no version alignment left to ask for, and asking sends an agent
     * after a non-problem. Asserted absent, not merely unmentioned.
     */
    it('tells a worktree-isolated subagent to run the cure and then escalate the COMMIT', () => {
        const sub = shimStaleDenyReason('0.4.431', '/tmp/wp-worktree', [SHIM_MARKER], true);
        expect(sub).toContain('You are a SUBAGENT and root= is not the tree you are standing in');
        expect(sub).toContain('Run Fix Option 1 below exactly as printed');
        expect(sub).toContain('never conclude a local cure cannot work');
        expect(sub).toContain('ESCALATE THE COMMIT');
        expect(sub).toContain('git -C /tmp/wp-worktree is refused here');
        expect(sub).toContain('Tell the coordinator to run git status in /tmp/wp-worktree and commit the regenerated shim');
        // The claim that made the old text false in the window where it fired.
        expect(sub).not.toContain('CANNOT lift this block');
        // The retired version-alignment clause: every tree is judged by main's shim already.
        expect(sub).not.toContain('so both trees are on the same @webpieces version');
        expect(sub).not.toContain('pnpm install in the main tree');
        // The cures and the block/allow decision are IDENTICAL to the main-agent form.
        expect(sub).toContain(`run EXACTLY: 'cd /tmp/wp-worktree && ${UPGRADE_SHIM_CMD}'`);
        expect(sub).not.toContain('"');
        expect(sub).not.toContain('\\');
    });

    /**
     * THE MESSAGE BUDGET, as a build failure rather than a habit. main landed a deliberate L0 message
     * diet (384cdae) and this deny regressed to ELEVEN sections / ~4,000 chars because each new finding
     * argued its case inside it. The budget bounds the WIDEST form of what an agent actually READS —
     * all three surfaces drifted, a governing root to name, the subagent branch, AND the guard-matrix
     * pointer hook-core appends (bounding the builder alone would pin a ceiling that is not the real
     * one). If a change needs more room, cut something that ARGUES rather than raising this number.
     *
     * THE NUMBER MOVED UP, ON PURPOSE, AND ONLY ONCE. The house format costs real characters — section
     * headings, one line per drifted surface, a `Fix Option N:` label above each command — and buys the
     * property that made the diet worth doing in the first place: the two commands are now findable
     * without reading the prose. SHORTER WAS NEVER THE GOAL, SCANNABLE WAS. The other addition is the
     * three-way-join line (`layer=`/`fault=`/`row=` plus the matrix citation), which is not argument
     * either — it is the coordinate that makes a transcript debuggable against the log.
     *
     * So: 3,850, against 3,357 for the old paragraph form and 4,666 before the original trim. It leaves
     * roughly 100 chars of slack — enough that renaming a surface constant does not fail the build, not
     * enough to re-admit a paragraph.
     */
    it('stays inside the L0 message budget in its widest form, pointer included', () => {
        const widest = shimStaleDenyReason('0.4.624', '/tmp/wp-root',
            [SHIM_MARKER, REGISTRATION_SURFACE, ENV_SURFACE], true)
            + guardMatrixPointer(`/repo/.webpieces/instruct-ai/${GUARD_MATRIX_DOC}`);
        expect(widest.length).toBeLessThan(3850);
    });

    // How the deny names the tree it judged (root= / projectDir=) lives in shim-governing-root.spec.ts,
    // beside the governingShimRoot tests it belongs with.
});

/**
 * ONE ANSWER PER QUESTION, ACROSS EVERY SURFACE THAT ANSWERS IT.
 *
 * The question is "may a worktree have its own node_modules?" and the answer is YES — nx, vitest and the
 * eslint plugin all execute in that tree and load from it, and `pnpm add <anything>` creates one. The
 * only invariant is that its @webpieces version EQUALS the main tree's.
 *
 * This assertion exists because the repo answered it BOTH ways at once. The L0 deny and the drift note
 * said "install here, that works"; L1 row 8, the L1 doc and CLAUDE.md said "a worktree needs no install
 * of its own ... a worktree cannot". An agent that follows the first is then blocked by the second and
 * ping-pongs between two cures — the multi-cure straddle these messages exist to end. Measured
 * 2026-08-10: the drift guard told a worktree agent to install locally, it did, and the block lifted,
 * while row 8 was telling it the opposite.
 *
 * It greps the RENDERED surfaces, not the source constants, so a new message inherits the ban for free.
 */
describe('no guard surface may tell an agent a worktree gets no node_modules of its own', () => {
    const banned = ['needs no install of its own', 'a worktree cannot', 'a worktree borrows'];
    const surfaces = new Map<string, string>([
        ['L0 fault-S deny', shimStaleDenyReason('0.4.624', '/tmp/wp-root',
            [SHIM_MARKER, REGISTRATION_SURFACE, ENV_SURFACE], true)],
        ['the rendered shim (D/X/U/K)', renderShim()],
        ['the L1 doc (row 8 remedy + the evaluation order)', renderL1Doc()],
        // THE LAST GAP, and the surface most likely to regrow the phrase: VersionSyncGuard IS L1 row 8,
        // i.e. the guard that talks about worktrees for a living, and it was pinned only by a single
        // `not.toContain` local to its own spec. It was left out because it reads pnpm-workspace.yaml and
        // node_modules off disk, so rendering it needs fixtures; version-sync.spec.ts already builds
        // exactly those, and exports the render so there stays ONE definition of a skewed worktree.
        ['the L1 row-8 report (VersionSyncGuard)', renderVersionSyncRow8Report()],
    ]);

    for (const [name, text] of surfaces) {
        it(`${name} states the version rule, not a no-install rule`, () => {
            for (const phrase of banned) expect(text, `${name} still says: ${phrase}`).not.toContain(phrase);
        });
    }
});
