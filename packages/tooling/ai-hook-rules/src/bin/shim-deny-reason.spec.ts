import { describe, it, expect } from 'vitest';

import { GUARD_MATRIX_DOC, guardMatrixPointer } from '../core/l0-matrix';
import { renderL1Doc } from '../core/l1-doc';
import { shimStaleDenyReason } from './shim-deny-reason';
import { INSTALL_HOOKS_CMD, NO_CHAINING_RULE, RESTORE_SHIM_CMD, SHIM_MARKER, UPGRADE_SHIM_CMD, renderShim } from './shim';
import { ENV_SURFACE, REGISTRATION_SURFACE } from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';

/**
 * HOW the self-guard's deny SPELLS its cures. Two numbered OPTIONs, each quoted, plus NO_CHAINING_RULE
 * (see its audit-log origin). The ORDER is load-bearing: `wp-upgrade-shim` LEADS because it is the only
 * cure that repairs ALL THREE managed surfaces — ai-hook.sh, the settings.json registration and the
 * managed env entry — and it also deletes the retired guarantee-root.sh, while still touching NO config and importing only fs/path, so it runs on a broken
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
        expect(reason).toContain('OPTION 1 (preferred');
        for (const cmd of [UPGRADE_SHIM_CMD, RESTORE_SHIM_CMD]) {
            expect(reason).toContain(`run EXACTLY this command: '${cmd}'`);
        }
        expect(reason.indexOf(UPGRADE_SHIM_CMD)).toBeLessThan(reason.indexOf(RESTORE_SHIM_CMD));
    });

    // The installer is named ONLY to warn against it. An agent that runs it here waits forever on a
    // prompt it cannot see, and reports the guard as a deadlock.
    it('warns off the installer, which prompts twice and hangs a non-interactive session', () => {
        expect(reason).toContain(`Do NOT use the bare '${INSTALL_HOOKS_CMD}' here`);
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
     * THE SUBAGENT LINE. `agent_id` arrives on the PreToolUse stdin payload and Claude Code populates it
     * only off the main loop, so its presence is a clean discriminator (`agent_type` is NOT — it is
     * always populated). hook-core derives the flag; this is the text it selects.
     */
    it('adds the subagent line only when the payload said so, and keeps it JSON-safe', () => {
        const sub = shimStaleDenyReason('0.4.431', '', [SHIM_MARKER], true);
        expect(sub).toContain('YOU ARE RUNNING IN A SUBAGENT');
        expect(sub).not.toContain('"');
        expect(sub).not.toContain('\\');
        // The block/allow decision and the cures are identical — only the explanation grows.
        expect(sub).toContain(`run EXACTLY this command: '${UPGRADE_SHIM_CMD}'`);
        expect(reason).not.toContain('SUBAGENT');
    });

    /**
     * TWO CURES, BOTH REAL, AND NEITHER OF THEM "YOU CANNOT FIX THIS HERE". The sentence used to state
     * flatly that a cure run in the subagent's own worktree CANNOT lift the block, because the hooks
     * resolve through CLAUDE_PROJECT_DIR and that names the MAIN tree. That is only true once a repo is
     * on the ABSOLUTE two-hook registration; in the PRE-FLIP window the relative form runs the
     * worktree's OWN ai-hook.sh, and measured 2026-08-10 a worktree subagent cured in place, the block
     * lifted, and the upgrade finished with a green build and a merged PR — with the deny's own root=
     * naming that worktree. So A (cure here) is real. B is real too and fixes something ELSE: a subagent
     * cannot reach the main clone, so aligning the two trees is an ESCALATION, and skipping it is how
     * the repo ends up with two trees on two @webpieces releases. WHICH tree to repair is answered by
     * the root=/projectDir= verdict (shim-governing-root.spec.ts), not restated here.
     */
    it('offers a subagent BOTH cures - cure here, and escalate to align the main tree', () => {
        const sub = shimStaleDenyReason('0.4.431', '/tmp/wp-worktree', [SHIM_MARKER], true);
        expect(sub).toContain('TWO cures are real and they fix DIFFERENT things');
        expect(sub).toContain('A makes THIS tree work now, B stops the two trees disagreeing');
        expect(sub).toContain('DOES lift this block');
        expect(sub).toContain('never conclude a local cure cannot work');
        expect(sub).toContain('ESCALATE: ask the coordinator to run pnpm install in the main tree');
        // The claim that made the old text false in the window where it fired.
        expect(sub).not.toContain('CANNOT lift this block');
        // A worktree DOES need its own node_modules — nx, vitest and the eslint plugin load from it.
        // The invariant is version EQUALITY, never "do not install here", which the text got backwards
        // in both directions at different times.
        expect(sub).toContain('NEEDS its own node_modules');
        expect(sub).toContain('must EQUAL the main tree');
    });

    /**
     * THE MESSAGE DIET, as a build failure rather than a habit. main landed a deliberate L0 message diet
     * (384cdae) and this deny regressed to ELEVEN sections / ~4,000 chars because each new finding
     * argued its case inside it. The budget bounds the WIDEST form of what an agent actually READS —
     * all three surfaces drifted, a governing root to name, the subagent sentence, AND the guard-matrix
     * pointer hook-core appends (bounding the builder alone would pin a ceiling that is not the real
     * one). If a change needs more room, cut something that ARGUES rather than raising this number.
     *
     * THE NUMBER: that widest composed form measures 3,262 here, against 4,666 before the trim — and
     * ~490 of what remains is the two-cure list the subagent sentence gained, which is behaviour, not
     * argument. 3350 leaves ~90 chars of slack, enough that renaming a surface constant does not fail
     * the build but not enough to re-admit a paragraph. The main-loop form is 2,381, down from 3,961.
     */
    it('stays inside the L0 message budget in its widest form, pointer included', () => {
        const widest = shimStaleDenyReason('0.4.624', '/tmp/wp-root',
            [SHIM_MARKER, REGISTRATION_SURFACE, ENV_SURFACE], true)
            + guardMatrixPointer(`/repo/.webpieces/instruct-ai/${GUARD_MATRIX_DOC}`);
        expect(widest.length).toBeLessThan(3350);
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
        ['the rendered shim (D/X/U/K + WP_BORROW_NOTE)', renderShim()],
        ['the L1 doc (row 8 remedy + the evaluation order)', renderL1Doc()],
    ]);

    for (const [name, text] of surfaces) {
        it(`${name} states the version rule, not a no-install rule`, () => {
            for (const phrase of banned) expect(text, `${name} still says: ${phrase}`).not.toContain(phrase);
        });
    }
});
