import { describe, it, expect } from 'vitest';

import { shimStaleDenyReason } from './shim-deny-reason';
import { INSTALL_HOOKS_CMD, NO_CHAINING_RULE, RESTORE_SHIM_CMD, SHIM_MARKER, UPGRADE_SHIM_CMD } from './shim';
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
     * always populated). A subagent needs one extra sentence: the hooks blocking it resolve through
     * CLAUDE_PROJECT_DIR, which names the MAIN tree, so a cure run only in its own worktree cannot lift
     * the block. hook-core derives the flag; this is the text it selects.
     */
    it('adds the subagent line only when the payload said so, and keeps it JSON-safe', () => {
        const sub = shimStaleDenyReason('0.4.431', '', [SHIM_MARKER], true);
        expect(sub).toContain('YOU ARE RUNNING IN A SUBAGENT');
        expect(sub).toContain('CANNOT lift this block');
        expect(sub).toContain('MAIN tree is where pnpm install and the repair have to happen');
        expect(sub).toContain('aligned end state');
        expect(sub).not.toContain('"');
        expect(sub).not.toContain('\\');
        // The block/allow decision and the cures are identical — only the explanation grows.
        expect(sub).toContain(`run EXACTLY this command: '${UPGRADE_SHIM_CMD}'`);
        expect(reason).not.toContain('SUBAGENT');
    });

    // How the deny names the tree it judged (root= / projectDir=) lives in shim-governing-root.spec.ts,
    // beside the governingShimRoot tests it belongs with.
});
