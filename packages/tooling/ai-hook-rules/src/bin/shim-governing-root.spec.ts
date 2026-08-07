import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { CLAUDE_PROJECT_DIR_ENV, CLAUDE_PROJECT_DIR_UNSET } from '@webpieces/rules-config';

import { renderShim, committedShimStale, governingShimRoot, isShimCureCommand, shimStaleDenyReason, SHIM_MARKER, UPGRADE_SHIM_CMD, RESTORE_SHIM_CMD } from './shim';
import { ShimTestkit } from './shim-testkit';

const kit = new ShimTestkit();

/**
 * governingShimRoot — the root the DECIDING BINARY owns, resolved from its own __dirname and from
 * nothing else. This is the whole of the two-tree-straddle fix: the shim file being compared and the
 * renderShim() it is compared against must provably come from the SAME install.
 */
describe('governingShimRoot — the root resolves from the MODULE, never the cwd', () => {
    const moduleDirOf = (root: string): string =>
        path.join(root, 'node_modules', '@webpieces', 'ai-hook-rules', 'src', 'bin');

    it('resolves a plain node_modules install back to the root that owns the shim', () => {
        const root = kit.stageCommittedShim(renderShim());
        expect(governingShimRoot(moduleDirOf(root))).toBe(root);
    });

    // The OUTERMOST-wins case. pnpm's linked layout puts a SECOND node_modules inside the store; an
    // innermost (or first-ancestor-with-a-shim) rule lands in the store and gets this wrong.
    it('resolves the pnpm NESTED store path to the outermost root, not the inner store dir', () => {
        const root = kit.stageCommittedShim(renderShim());
        const moduleDir = path.join(root, 'node_modules', '.pnpm', '@webpieces+ai-hook-rules@1',
            'node_modules', '@webpieces', 'ai-hook-rules', 'src', 'bin');
        expect(governingShimRoot(moduleDir)).toBe(root);
    });

    it('null when the resolved root owns no committed shim (global install / fresh clone)', () => {
        expect(governingShimRoot(moduleDirOf(kit.stageCommittedShim(null)))).toBeNull();
    });

    // The source-checkout case: vitest maps @webpieces/* to packages/**/src via tsconfig paths, so
    // __dirname has no node_modules segment at all. Walk up to the nearest ancestor owning a shim.
    it('with no node_modules segment, walks up to the nearest ancestor owning a shim', () => {
        const root = kit.stageCommittedShim(renderShim());
        const moduleDir = path.join(root, 'packages', 'tooling', 'ai-hook-rules', 'src', 'bin');
        fs.mkdirSync(moduleDir, { recursive: true });
        expect(governingShimRoot(moduleDir)).toBe(root);
        expect(governingShimRoot(path.join(kit.stageCommittedShim(null), 'packages', 'x'))).toBeNull();
    });

    // REGRESSION — THE TWO-TREE STRADDLE (the actual bug). CLAUDE_PROJECT_DIR is fixed at session start,
    // so an agent that `cd`s into another checkout keeps running the SESSION-ROOT tree's binary while the
    // old code walked up from the CWD into the OTHER tree — two trees at two @webpieces versions, one
    // comparison. It could never converge: curing in the cwd tree renders with THAT tree's renderShim(),
    // which the running binary's renderShim() still rejects. The decision must follow the MODULE's tree.
    // The two roots below stand in for "the tree the binary came from" and "some other tree the cwd
    // wandered into" — neither is privileged, and which is which is decided only by the moduleDir.
    it('REGRESSION two-tree straddle: the decision follows the MODULE tree and cwd cannot change it', () => {
        const ownTree = kit.stageCommittedShim(renderShim());                          // in sync with THIS binary
        const otherTree = kit.stageCommittedShim(renderShim() + '\n# other release\n'); // a different release

        expect(committedShimStale(governingShimRoot(moduleDirOf(ownTree)))).toBe(false);
        expect(committedShimStale(governingShimRoot(moduleDirOf(otherTree)))).toBe(true);

        // ...and standing in the OTHER tree cannot flip either answer. That is the straddle, gone.
        // (vitest worker threads have no process.chdir — then the assertions above already carry it.)
        if (typeof process.chdir !== 'function') return;
        const original = process.cwd();
        // webpieces-disable no-unmanaged-exceptions -- try/FINALLY only (no catch): a failing expect must not leave the whole suite in a temp cwd.
        try {
            process.chdir(otherTree);
            expect(committedShimStale(governingShimRoot(moduleDirOf(ownTree)))).toBe(false);
            process.chdir(ownTree);
            expect(committedShimStale(governingShimRoot(moduleDirOf(otherTree)))).toBe(true);
        } finally {
            process.chdir(original);
        }
    });
});

/**
 * How the self-guard's DENY names the tree it judged. These live beside governingShimRoot rather than
 * with the rest of the deny-text tests because they are the same fix: the root the decision resolved is
 * only useful to a blocked agent if the message actually tells it which tree that was.
 */
describe('shimStaleDenyReason — naming the governing tree it judged', () => {
    const reason = shimStaleDenyReason('0.4.431', '', [SHIM_MARKER]);

    // The cause list, not an assertion. "(it was reverted or hand-edited)" is frequently FALSE — the
    // ordinary case is a shim whose logic predates this binary — and that false certainty sent a real
    // agent hunting a tamper that never happened.
    it('states the cause as a LIST including the predates-this-binary case, not a flat tamper claim', () => {
        expect(reason).toContain('reverted, hand-edited, or predating this binary');
        expect(reason).not.toContain('(it was reverted or hand-edited)');
    });

    // With a governing root, the deny must NAME the tree being judged and anchor the cure to it —
    // otherwise an AI whose cwd is a different tree cures the wrong tree forever (the straddle).
    it('names the governing root and prescribes a cd-anchored cure the L0 allowlist still accepts', () => {
        const root = '/tmp/wp-governing-tree';
        const r = shimStaleDenyReason('0.4.560', root, [SHIM_MARKER]);
        expect(r).toContain(`root=${root}`);
        expect(r).toContain(`run EXACTLY this command: 'cd ${root} && ${UPGRADE_SHIM_CMD}'`);
        expect(isShimCureCommand(`cd ${root} && ${UPGRADE_SHIM_CMD}`)).toBe(true);
        expect(isShimCureCommand(`cd ${root} && ${RESTORE_SHIM_CMD}`)).toBe(true);
        expect(r).not.toContain('"');
        expect(r).not.toContain('\\');
    });

    // The two fields #574 put on every L1 invocation line, now in the deny an agent reads IN the moment.
    // CLAUDE_PROJECT_DIR does NOT reach plain Bash tool calls (verified: `printenv CLAUDE_PROJECT_DIR`
    // exits 1 from a Bash tool call while the hook process sees it), so the agent cannot look it up —
    // printing it here is the only way it learns which tree the session is anchored to.
    it('reports root= and projectDir= and says out loud whether they agree', () => {
        const original = process.env[CLAUDE_PROJECT_DIR_ENV];
        // webpieces-disable no-unmanaged-exceptions -- try/FINALLY only (no catch): a failing expect must not leak an env var into the rest of the suite.
        try {
            process.env[CLAUDE_PROJECT_DIR_ENV] = '/tmp/wp-session-root';
            const disagree = shimStaleDenyReason('0.4.560', '/tmp/wp-other-tree', [SHIM_MARKER]);
            expect(disagree).toContain('projectDir=/tmp/wp-session-root');
            expect(disagree).toContain('These two DISAGREE');

            const agree = shimStaleDenyReason('0.4.560', '/tmp/wp-session-root', [SHIM_MARKER]);
            expect(agree).toContain('These two AGREE');

            delete process.env[CLAUDE_PROJECT_DIR_ENV];
            expect(shimStaleDenyReason('0.4.560', '/tmp/wp-other-tree', [SHIM_MARKER]))
                .toContain(`projectDir=${CLAUDE_PROJECT_DIR_UNSET}`);   // absent != set-but-empty
        } finally {
            if (original === undefined) delete process.env[CLAUDE_PROJECT_DIR_ENV];
            else process.env[CLAUDE_PROJECT_DIR_ENV] = original;
        }
    });

    // JSON-safety must survive a HOSTILE path, not merely a tidy one: these two chars are stripped from
    // every interpolated path, so no directory name can corrupt the PreToolUse decision payload.
    it('stays JSON-safe even when the root itself carries a double-quote or backslash', () => {
        const r = shimStaleDenyReason('0.4.560', '/tmp/we"ird\\path', [SHIM_MARKER]);
        expect(r).not.toContain('"');
        expect(r).not.toContain('\\');
        expect(r).toContain(UPGRADE_SHIM_CMD);          // the cure survives an unusable root
        expect(r).not.toContain('cd /tmp/weirdpath &&'); // ...but is NOT cd-anchored to a path CD_PREFIX rejects
    });
});
