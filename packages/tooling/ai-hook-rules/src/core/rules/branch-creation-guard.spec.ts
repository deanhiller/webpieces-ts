import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BranchCreationGuardConfig } from '@webpieces/rules-config';

import type { BashContext } from '../types';

// Mutable git state the mocked execSync/spawnSync read. vi.hoisted so the vi.mock factories (hoisted
// above imports) can close over it without a TDZ error. `localBranches` feeds the cap check's
// `git for-each-ref`; `cacheJson` is the .webpieces/merged-branches.json the cap check reads (null =
// no cache on disk, which must fail OPEN).
const git = vi.hoisted(() => ({
    branch: 'main',
    behind: 0,
    localBranches: ['main'] as string[],
    cacheJson: null as string | null,
}));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return `${git.branch}\n`;
        if (cmd.includes('rev-list')) return `${git.behind}\n`;
        return '';
    },
    spawnSync: (cmd: string, args: string[]): { status: number; stdout: string } => {
        if (cmd === 'git' && args[0] === 'for-each-ref') {
            return { status: 0, stdout: git.localBranches.join('\n') + '\n' };
        }
        if (cmd === 'git' && args.includes('--abbrev-ref')) {
            return { status: 0, stdout: `${git.branch}\n` };
        }
        return { status: 1, stdout: '' };
    },
}));

type FsModule = typeof import('fs');

vi.mock('fs', async (importOriginal: () => Promise<FsModule>): Promise<FsModule> => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: (p: fs.PathLike): boolean => {
            if (String(p).includes('merged-branches.json')) return git.cacheJson !== null;
            return actual.existsSync(p);
        },
        readFileSync: ((p: fs.PathLike, enc?: BufferEncoding): string => {
            if (String(p).includes('merged-branches.json')) return git.cacheJson ?? '';
            return actual.readFileSync(p, enc) as unknown as string;
        }) as FsModule['readFileSync'],
    };
});

import type * as fs from 'fs';

import { BranchCreationGuardRule } from './branch-creation-guard';

function ctx(command: string): BashContext {
    return { command, workspaceRoot: '/tmp/x', options: {} } as BashContext;
}

// A merged-branches cache with `deletable` entries — the shape the detached refresher writes.
function cacheWith(deletable: string[], keep: string[] = []): string {
    return JSON.stringify({
        timestamp: '2026-07-14T00:00:00.000Z',
        deletable: deletable.map((b: string, i: number): object =>
            ({ branch: b, reason: `PR #${String(100 + i)} merged`, pr: 100 + i })),
        keep: keep.map((b: string): object =>
            ({ branch: b, reason: 'no merged PR found — a human must decide', pr: 0 })),
    });
}

function rule(mode: 'ON' | 'OFF' | 'ON_NO_SUBBRANCHES', extra: Partial<BranchCreationGuardConfig> = {}): BranchCreationGuardRule {
    const cfg = new BranchCreationGuardConfig();
    cfg.mode = mode;
    Object.assign(cfg, extra);
    return new BranchCreationGuardRule(cfg);
}

// Top-level (not per-describe) so the branch-count/cache state cannot leak ACROSS describe blocks —
// a leaked over-cap count would trip the cap check in suites that have nothing to do with it.
beforeEach(() => {
    git.branch = 'main';
    git.behind = 0;
    git.localBranches = ['main'];
    git.cacheJson = null;
});

describe('branch-creation-guard', () => {
    it('ignores commands that do not create a branch', () => {
        expect(rule('ON').check(ctx('git status')).length).toBe(0);
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git branch -d old')).length).toBe(0);
    });

    it('on up-to-date main, allows branch creation', () => {
        git.branch = 'main';
        git.behind = 0;
        expect(rule('ON').check(ctx('git checkout -b dean/feature')).length).toBe(0);
    });

    it('on stale main, blocks with a pull-first message', () => {
        git.branch = 'main';
        git.behind = 3;
        const violations = rule('ON').check(ctx('git checkout -b dean/feature'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('behind origin/main');
    });

    it('mode ON: off a feature branch, blocks and still offers the sub-branch affordance', () => {
        git.branch = 'dean/existing';
        const violations = rule('ON').check(ctx('git checkout -b dean/another'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain("not main");
        expect(violations[0].message).toContain('subBranchNaming');
    });

    it('mode ON_NO_SUBBRANCHES: off a feature branch, blocks with strict recovery + epoch escape, no sub-branch affordance', () => {
        git.branch = 'dean/existing';
        const violations = rule('ON_NO_SUBBRANCHES').check(ctx('git checkout -b dean/another'));
        expect(violations.length).toBe(1);
        const msg = violations[0].message;
        expect(msg).toContain('git fetch origin main && git checkout -b dean/another origin/main');
        expect(msg).toContain('instead of stacking it on this branch');
        expect(msg).toContain('ignoreModifiedUntilEpoch');
        // The strict mode must NOT dangle the sub-branch naming convention.
        expect(msg).not.toContain('subBranchNaming');
    });

    it('surfaces the configured branchFormat in the block message', () => {
        git.branch = 'dean/existing';
        const format = 'Name it dean/<thing> lowercase';
        const violations = rule('ON_NO_SUBBRANCHES', { branchFormat: format }).check(ctx('git checkout -b foo'));
        expect(violations[0].message).toContain(format);
    });

    it('fixHint is mode-aware: ON_NO_SUBBRANCHES points to the epoch escape; ON points to subBranchNaming', () => {
        const flatten = (fh: { mainMessage: string; fixOptions: readonly { text: string }[] }): string =>
            [fh.mainMessage, ...fh.fixOptions.map((o: { text: string }): string => o.text)].join('\n');

        const strict = flatten(rule('ON_NO_SUBBRANCHES').fixHint);
        expect(strict).toContain('ignoreModifiedUntilEpoch');
        expect(strict).not.toContain('subBranchNaming');

        const normal = flatten(rule('ON').fixHint);
        expect(normal).toContain('subBranchNaming');
    });
});

describe('branch-creation-guard origin/main base (worktree-native)', () => {
    it('allows an explicit origin/main base from any branch or worktree', () => {
        git.branch = 'dean/existing';
        expect(rule('ON').check(ctx('git checkout -b dean/feature origin/main')).length).toBe(0);
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git checkout -b dean/feature origin/main')).length).toBe(0);
        expect(rule('ON').check(ctx('git switch -c dean/feature origin/main')).length).toBe(0);
        // ...but a reserved wp<number> name is still blocked even when based off origin/main.
        expect(rule('ON').check(ctx('git checkout -b dean/featwp2 origin/main')).length).toBe(1);
    });
});

// A read-only LISTING is not a creation. `git branch | wc -l` used to be parsed as "create a branch
// named `|`" and blocked — which would have made the guard block the very cleanup it demands.
describe('branch-creation-guard does not fire on read-only branch commands', () => {
    it('allows listing, piping, and deleting branches', () => {
        git.branch = 'main';
        expect(rule('ON').check(ctx('git branch | wc -l')).length).toBe(0);
        expect(rule('ON').check(ctx("git branch --format='%(refname:short)'")).length).toBe(0);
        expect(rule('ON').check(ctx('git branch -D dean/old-feature')).length).toBe(0);
        expect(rule('ON').check(ctx('git branch --list')).length).toBe(0);
        expect(rule('ON').check(ctx('git for-each-ref --format=%(refname:short) refs/heads/')).length).toBe(0);
    });

    it('still catches a real bare-name creation', () => {
        git.branch = 'dean/existing';
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git branch dean/newthing')).length).toBe(1);
    });
});

/**
 * The guard regex-scans the raw command string and has no notion of quoting, so a commit message that
 * MENTIONS a branch command was parsed as one. Every case below actually blocked while this feature was
 * being built — the third one blocked the feature's own commit. It matters more now that the cap runs
 * before the origin/main allow: at the cap, a merely-mentioned branch command would block your commit.
 */
describe('branch-creation-guard ignores git commands quoted inside prose', () => {
    it('does not treat a heredoc commit message mentioning a branch command as a creation', () => {
        git.branch = 'dean/existing';
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith(['a', 'b']);

        const heredoc = [
            "git commit -F - <<'EOF'",
            'Fix the guard',
            'The cap is checked BEFORE the origin/main allow — `git checkout -b x origin/main`',
            'is the path the AI always takes.',
            'EOF',
        ].join('\n');

        expect(rule('ON_NO_SUBBRANCHES', { maxLocalBranches: 5 }).check(ctx(heredoc)).length).toBe(0);
    });

    it('does not treat a -m commit message mentioning a branch command as a creation', () => {
        git.branch = 'dean/existing';
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git commit -m "explain git checkout -b foo here"')).length).toBe(0);
    });

    // A quoted span with NO whitespace is a single token (a branch name), not prose — so quoting the
    // name must NOT smuggle a real creation past the guard.
    it('still blocks a real creation whose branch name is quoted', () => {
        git.branch = 'dean/existing';
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git checkout -b "dean/sneaky"')).length).toBe(1);
    });

    // The sanctioned command must be allowed even when a trailing quote/backtick follows origin/main —
    // the ALLOW pattern must not be stricter about delimiters than the BLOCK pattern.
    it('allows the sanctioned origin/main base regardless of the trailing delimiter', () => {
        git.branch = 'dean/existing';
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git checkout -b "dean/foo" origin/main')).length).toBe(0);
    });
});

describe('branch-creation-guard local-branch cap', () => {
    // The cap MUST be enforced on the origin/main path — that is the one command the AI always uses,
    // so a cap checked after the origin/main allow would never fire.
    it('blocks branch creation off origin/main once at the cap, and names the reap command', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith(['a', 'b', 'c']);

        const r = rule('ON_NO_SUBBRANCHES', { maxLocalBranches: 5 });
        const violations = r.check(ctx('git checkout -b dean/next origin/main'));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('5 local branches');
        expect(violations[0].message).toContain('3 of them are dead');

        const hint = r.fixHint;
        const flat = [hint.mainMessage, ...hint.fixOptions.map((o: { text: string }): string => o.text)].join('\n');
        expect(flat).toContain('git branch -D a b c');
        expect(flat).toContain('merged-branches.json');
        expect(flat).toContain('maxLocalBranches');
    });

    it('allows creation when under the cap', () => {
        git.localBranches = ['main', 'a', 'b'];
        git.cacheJson = cacheWith(['a']);
        expect(rule('ON', { maxLocalBranches: 5 }).check(ctx('git checkout -b dean/next origin/main')).length).toBe(0);
    });

    // Fail OPEN: with no cache on disk we have no idea what is safe to delete, so we must not block.
    it('does not block when the cache has not been generated yet', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e', 'f'];
        git.cacheJson = null;
        expect(rule('ON', { maxLocalBranches: 5 }).check(ctx('git checkout -b dean/next origin/main')).length).toBe(0);
    });

    // Legitimately 6 live branches: nothing is reapable, so the ONLY way forward is a config change.
    // The hint must say so rather than dead-ending.
    it('at the cap with nothing reapable, offers the raise-cap and bypass escapes', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith([], ['a', 'b', 'c', 'd', 'e']);

        const r = rule('ON', { maxLocalBranches: 5 });
        const violations = r.check(ctx('git checkout -b dean/next origin/main'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('None of them are dead');

        const hint = r.fixHint;
        const flat = [hint.mainMessage, ...hint.fixOptions.map((o: { text: string }): string => o.text)].join('\n');
        expect(flat).not.toContain('git branch -D');
        expect(flat).toContain('maxLocalBranches');
        expect(flat).toContain('ignoreModifiedUntilEpoch');
        expect(flat).toContain('5 unmerged branch(es) with real commits were deliberately SPARED');
    });

    it('defaults the cap to 5 when unconfigured', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith(['a']);
        expect(rule('ON').check(ctx('git checkout -b dean/next origin/main')).length).toBe(1);
    });
});

describe('branch-creation-guard reserved wp<number> suffix', () => {
    it('blocks a branch name ending in the reserved wp<number> generation marker', () => {
        git.branch = 'main';
        git.behind = 0;
        const violations = rule('ON').check(ctx('git checkout -b dean/upgrade-webpieceswp2'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('reserved');
        expect(violations[0].message).toContain('wp<number>');
    });

    it('does NOT block a name that merely contains digits or a version', () => {
        git.branch = 'main';
        git.behind = 0;
        expect(rule('ON').check(ctx('git checkout -b dean/upgrade-webpieces-0.3.213')).length).toBe(0);
    });
});
