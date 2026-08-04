import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BranchCreationGuardConfig } from '@webpieces/rules-config';

import { BashContext } from '../types';

// Mutable git state the mocked execSync/spawnSync read. vi.hoisted so the vi.mock factories (hoisted
// above imports) can close over it without a TDZ error. `localBranches` feeds the cap check's
// `git for-each-ref`; `cacheJson` is the .webpieces/merged-branches.json the cap check reads (null =
// no cache on disk, which must fail OPEN).
const git = vi.hoisted(() => ({
    branch: 'main',
    behind: 0,
    localBranches: ['main'] as string[],
    cacheJson: null as string | null,
    // Raw `git worktree list --porcelain` output. The first record is always the primary clone, which
    // is never counted against the worktree cap.
    worktreePorcelain: 'worktree /tmp/x\nHEAD abc\nbranch refs/heads/main\n',
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
        if (cmd === 'git' && args[0] === 'worktree') {
            return { status: 0, stdout: git.worktreePorcelain };
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
    return new BashContext(command, '/tmp/x');
}

// A merged-branches cache with `deletable` entries — the shape the detached refresher writes.
//
// The timestamp is NOW by default. A cache is only quotable as fact while it is fresh (the guard says
// "the cached verdicts are stale" instead of asserting a count once it ages out), so a hardcoded date
// would make every cap test in this file exercise the stale path. `stale()` below opts into it.
function cacheWith(deletable: string[], keep: string[] = [], worktrees: object[] = [], timestamp: string = new Date().toISOString()): string {
    return JSON.stringify({
        timestamp,
        deletable: deletable.map((b: string, i: number): object =>
            ({ branch: b, reason: `PR #${String(100 + i)} merged`, pr: 100 + i })),
        keep: keep.map((b: string): object =>
            ({ branch: b, reason: 'no merged PR found — a human must decide', pr: 0 })),
        worktrees,
    });
}

// One worktree verdict, as the refresher writes it into the cache's `worktrees` list.
function tree(path: string, branch: string, deletable: boolean): object {
    return { path, branch, reason: deletable ? 'PR #7 merged' : 'no merged PR found', pr: 0, deletable };
}

// The same cache, written long enough ago that nothing in it may be quoted as a present-tense fact.
function staleCacheWith(deletable: string[], keep: string[] = [], worktrees: object[] = []): string {
    return cacheWith(deletable, keep, worktrees, '2026-07-14T00:00:00.000Z');
}

// `git worktree list --porcelain` for the primary clone plus N linked worktrees named wt1..wtN.
function porcelain(linked: number): string {
    let out = 'worktree /tmp/x\nHEAD abc\nbranch refs/heads/main\n';
    for (let i = 1; i <= linked; i++) {
        out += `\nworktree /tmp/wt${String(i)}\nHEAD abc${String(i)}\nbranch refs/heads/feat${String(i)}\n`;
    }
    return out;
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
    git.worktreePorcelain = porcelain(0);
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
        expect(msg).toContain('turnOffRuleUntilEpoch');
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
        expect(strict).toContain('turnOffRuleUntilEpoch');
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
        expect(violations[0].message).toContain('5 parked local branches');
        expect(violations[0].message).toContain('pnpm wp-cleanup');

        const hint = r.fixHint;
        const flat = [hint.mainMessage, ...hint.fixOptions.map((o: { text: string }): string => o.text)].join('\n');
        // `pnpm wp-cleanup`, NOT `git branch -D a b c`: the multi-name form aborts wholesale on the
        // first branch git refuses, and a bare `-D` makes agents stop and ask instead of cleaning.
        // The dead branches are NOT named here — wp-cleanup names them, from fresh verdicts, as it
        // deletes them. Naming them twice was how this message grew to forty lines.
        expect(flat).toContain('pnpm wp-cleanup');
        expect(flat).not.toContain('git branch -D');
        expect(flat).not.toContain('merged-branches.json');
        expect(flat).toContain('maxLocalBranches');
    });

    it('allows creation when under the cap', () => {
        git.localBranches = ['main', 'a', 'b'];
        git.cacheJson = cacheWith(['a']);
        expect(rule('ON', { maxLocalBranches: 5 }).check(ctx('git checkout -b dean/next origin/main')).length).toBe(0);
    });
});

describe('branch-creation-guard restore-at-SHA (the wp-cleanup undo path)', () => {
    /**
     * The `recover=git branch <name> <sha>` command wp-cleanup logs for every branch it reaps must
     * always run. Without this the safety story is circular: deletes are "safe because they're one
     * command away from undo", and that command is refused — observed live, the guard answered a
     * restore with "create it off origin/main instead", which is exactly the content being restored.
     * Checked ahead of the caps too, so a full branch list cannot trap you on the recovery path.
     */
    it('always allows restoring a reaped branch at its logged SHA, even at the cap', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith(['a', 'b', 'c']);

        const r = rule('ON_NO_SUBBRANCHES', { maxLocalBranches: 5 });
        const restore = 'git branch dean/reaped 58368f29991becc08497b11a73eb63a00c171ff1';
        expect(r.check(ctx(restore)).length).toBe(0);
        // The short form the log's `recover=` may carry works too.
        expect(r.check(ctx('git branch dean/reaped 58368f29')).length).toBe(0);
    });

    // The allow keys off a COMMITTISH base, not any second argument. `git branch x main` is an
    // ordinary creation and must still spend/respect the cap.
    it('still blocks a plain branch creation off a non-sha base at the cap', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith(['a', 'b', 'c']);
        expect(rule('ON_NO_SUBBRANCHES', { maxLocalBranches: 5 }).check(ctx('git branch dean/next main')).length).toBe(1);
    });
});

describe('branch-creation-guard cap fail-open and escapes', () => {
    // Fail OPEN: with no cache on disk we have no idea what is safe to delete, so we must not block.
    it('does not block when the cache has not been generated yet', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e', 'f'];
        git.cacheJson = null;
        expect(rule('ON', { maxLocalBranches: 5 }).check(ctx('git checkout -b dean/next origin/main')).length).toBe(0);
    });

    /**
     * SHORT. This is the whole remedy, and it fits in two options.
     *
     * It used to print, inline in a blocked-Bash report, every spared branch with its SHA, PR state,
     * unique-commit count and prose reason, plus instructions to paste that table at the human and
     * ask which may go. The human who received one: "I am tired of AI asking me to cleanup things it
     * can do by itself". Two things changed — pnpm wp-cleanup now reaps the redundant groups
     * unattended (so an agent can just run it), and the guard says one line instead of forty.
     */
    it('at the cap, says one short thing: run pnpm wp-cleanup — and never pastes a branch table', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith([], ['a', 'b', 'c', 'd', 'e']);

        const r = rule('ON', { maxLocalBranches: 5 });
        const violations = r.check(ctx('git checkout -b dean/next origin/main'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('5 parked local branches');
        expect(violations[0].message).toContain('pnpm wp-cleanup');

        const hint = r.fixHint;
        const preferred = hint.fixOptions.filter((o: { preferred: boolean }): boolean => o.preferred);
        expect(preferred.length).toBe(1);
        expect(preferred[0].text).toContain('pnpm wp-cleanup');

        const flat = [hint.mainMessage, ...hint.fixOptions.map((o: { text: string }): string => o.text)].join('\n');
        // Two options, and no per-branch table: the spared branches are wp-cleanup's to report.
        expect(hint.fixOptions.length).toBe(2);
        expect(flat).not.toContain('git branch -D');
        expect(flat).not.toContain('commit(s) of its own');
        expect(flat.length).toBeLessThan(400);
        // The config knobs are still named, still gated on a human.
        expect(flat).toContain('maxLocalBranches');
        expect(flat).toContain('turnOffRuleUntilEpoch');
        expect(flat).toContain('explicit yes');
    });

    it('defaults the cap to 5 when unconfigured', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = cacheWith(['a']);
        expect(rule('ON').check(ctx('git checkout -b dean/next origin/main')).length).toBe(1);
    });

});

describe('branch-creation-guard separate branch/worktree budgets', () => {
    // The two budgets are SEPARATE. Worktree-held branches are the worktree cap's problem; if they also
    // spent the branch budget, five worktrees would leave room for zero branches and no branch could
    // ever be created again.
    it('does not count worktree-held branches against the branch cap', () => {
        git.localBranches = ['main', 'feat1', 'feat2', 'feat3', 'feat4', 'feat5', 'parked'];
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = cacheWith([]);

        // 5 held + 1 parked. The branch cap sees ONE branch, so this is nowhere near it.
        expect(rule('ON', { maxLocalBranches: 5 }).check(ctx('git checkout -b dean/next origin/main')).length).toBe(0);
    });
});

describe('branch-creation-guard worktree cap', () => {
    // `git worktree add ... -b <name> origin/main` is the command docs/git-workflow.md recommends. It
    // creates a branch, so it must obey every branch rule — and it spends the worktree budget too.
    it('allows a worktree add off origin/main when under both caps', () => {
        git.branch = 'dean/existing';
        git.worktreePorcelain = porcelain(2);
        git.cacheJson = cacheWith([]);
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git worktree add ../f -b dean/next origin/main')).length).toBe(0);
    });

    /**
     * THE REGRESSION TEST FOR THE INCIDENT. This guard used to print
     *   `git worktree prune && git worktree remove <a> && … && git branch -D <x> <y> <z>`
     * and on 2026-07-30 that single line named three worktrees with live agents in them. It must never
     * come back: a chained delete of N things has no safe partial failure, and this guard does not own
     * reaping logic. It hands over to wp-cleanup, which archives, asks, and refuses its own tree.
     */
    it('blocks a worktree add at the cap and hands over to wp-cleanup — never a chained delete one-liner', () => {
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = cacheWith([], [], [
            tree('/tmp/wt1', 'feat1', true),
            tree('/tmp/wt2', 'feat2', true),
            tree('/tmp/wt3', 'feat3', false),
        ]);

        const r = rule('ON_NO_SUBBRANCHES', { maxWorktrees: 5 });
        const violations = r.check(ctx('git worktree add ../f -b dean/next origin/main'));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('5 linked worktrees');
        expect(violations[0].message).toContain('pnpm wp-cleanup');

        const hint = r.fixHint;
        const flat = [hint.violation, hint.mainMessage,
            ...hint.fixOptions.map((o: { text: string }): string => o.text)].join('\n');
        // NOTHING destructive, in any form, chained or single.
        expect(flat).not.toContain('git worktree remove');
        expect(flat).not.toContain('git worktree prune');
        expect(flat).not.toContain('git branch -D');
        expect(flat).not.toContain('&&');
        // …and the ONE thing it does say is the command that does this safely.
        expect(hint.fixOptions[0].preferred).toBe(true);
        expect(hint.fixOptions[0].text).toContain('pnpm wp-cleanup');
        expect(flat).toContain('maxWorktrees');
        // Short, and the per-worktree inventory belongs to wp-cleanup, not to a blocked-Bash report.
        expect(flat).not.toContain('/tmp/wt1');
        expect(flat.length).toBeLessThan(400);
        // Removing one by hand is still the thing an agent must not do.
        expect(flat).toContain('working in it right now');
    });

});

describe('branch-creation-guard treats an uncommitted worktree as live', () => {
    /**
     * The exact shape of the incident, end to end: a worktree created minutes ago with
     * `git worktree add -b … origin/main`, no commits yet, no PR — i.e. an agent working in it. It is
     * LIVE, and the guard must not name it as something that can be removed.
     */
    it('never offers a commitless, PR-less worktree for deletion — that is a live agent', () => {
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = cacheWith([], [], [
            // As the refresher now records it: spared, classification no-commits.
            { path: '/tmp/wt1', branch: 'dean/apipath', pr: 0, deletable: false,
                classification: 'no-commits',
                reason: 'no commits of its own — identical to origin/main. That is either an abandoned husk '
                    + 'OR a worktree/branch someone is working in right now' },
            tree('/tmp/wt2', 'feat2', false),
        ]);

        const r = rule('ON_NO_SUBBRANCHES', { maxWorktrees: 5 });
        expect(r.check(ctx('git worktree add ../f -b dean/next origin/main')).length).toBe(1);

        const hint = r.fixHint;
        const flat = [hint.violation, hint.mainMessage,
            ...hint.fixOptions.map((o: { text: string }): string => o.text)].join('\n');
        expect(flat).not.toContain('dean/apipath');
        expect(flat).not.toContain('no work can be lost');
        expect(flat).toContain('pnpm wp-cleanup');
        expect(flat).toContain('working in it right now');
    });

});

/**
 * Ticket part 4. The guard announced "8 parked local branches" over a repo with ONE, having quoted a
 * cache written before those branches were deleted. The defence is now absolute rather than
 * conditional: the cap messages quote NO cache-derived figure, stale or fresh. There is nothing to
 * caveat, because `pnpm wp-cleanup` — the one thing both messages say — recomputes from scratch.
 *
 * The counts that DO survive (5 parked branches, 5 linked worktrees) come from live git, not the cache.
 */
describe('branch-creation-guard never quotes a cache-derived count', () => {
    it('quotes no verdict figure on the worktree cap, however stale the cache', () => {
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = staleCacheWith([], [], [tree('/tmp/wt1', 'feat1', true)]);

        const r = rule('ON_NO_SUBBRANCHES', { maxWorktrees: 5 });
        const violations = r.check(ctx('git worktree add ../f -b dean/next origin/main'));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('5 linked worktrees');
        expect(violations[0].message).not.toContain('of them are dead');
        // …and it names no tree out of that cache either.
        const flat = r.fixHint.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(flat).toContain('pnpm wp-cleanup');
        expect(flat).not.toContain('/tmp/wt1');
    });

    // Same on the BRANCH cap: the live count, the command, nothing quoted out of the cache.
    it('quotes no verdict figure and no branch names on the branch cap', () => {
        git.localBranches = ['main', 'a', 'b', 'c', 'd', 'e'];
        git.cacheJson = staleCacheWith(['a', 'b', 'c']);

        const r = rule('ON_NO_SUBBRANCHES', { maxLocalBranches: 5 });
        const violations = r.check(ctx('git checkout -b dean/next origin/main'));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('5 parked local branches');
        expect(violations[0].message).not.toContain('of them are dead');

        const flat = r.fixHint.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(flat).toContain('pnpm wp-cleanup');
        expect(flat).not.toContain('it deletes these');
    });

});

describe('branch-creation-guard drops phantom cache entries', () => {
    it('names no cached worktree, including ones already removed', () => {
        // The cache still names two dead worktrees; only ONE of them is still in `git worktree list`.
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = cacheWith([], [], [
            tree('/tmp/wt1', 'feat1', true),
            tree('/tmp/already-removed', 'feat9', true),
        ]);

        const r = rule('ON_NO_SUBBRANCHES', { maxWorktrees: 5 });
        const violations = r.check(ctx('git worktree add ../f -b dean/next origin/main'));

        expect(violations.length).toBe(1);
        const flat = r.fixHint.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(flat).not.toContain('already-removed');
        expect(flat).not.toContain('/tmp/wt1');
    });

    /**
     * With nothing PROVABLY dead the guard used to have only two options left, and both loosened the
     * rule (raise maxWorktrees / set turnOffRuleUntilEpoch). wp-cleanup also PROMPTS about the
     * probably-dead worktrees, so there is always a remedy that can remove something.
     */
    it('still offers wp-cleanup when no worktree is provably dead', () => {
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = cacheWith([], [], [tree('/tmp/wt1', 'feat1', false)]);

        const r = rule('ON_NO_SUBBRANCHES', { maxWorktrees: 5 });
        expect(r.check(ctx('git worktree add ../f -b dean/next origin/main')).length).toBe(1);
        expect(r.fixHint.fixOptions[0].text).toContain('pnpm wp-cleanup');
    });

    it('defaults the worktree cap to 5, and fails OPEN with no cache on disk', () => {
        git.worktreePorcelain = porcelain(6);
        git.cacheJson = null;
        expect(rule('ON').check(ctx('git worktree add ../f -b dean/next origin/main')).length).toBe(0);

        git.cacheJson = cacheWith([], [], [tree('/tmp/wt1', 'feat1', true)]);
        expect(rule('ON').check(ctx('git worktree add ../f -b dean/next origin/main')).length).toBe(1);
    });
});

describe('branch-creation-guard worktree add obeys the branch rules', () => {
    // No -b: creates no branch, but still spends the worktree budget.
    it('caps a worktree add of an existing branch, which creates no branch at all', () => {
        git.worktreePorcelain = porcelain(5);
        git.cacheJson = cacheWith([], [], [tree('/tmp/wt1', 'feat1', true)]);
        const violations = rule('ON', { maxWorktrees: 5 }).check(ctx('git worktree add ../f existing-branch'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('linked worktrees');
    });

    it('applies the reserved wp<number> suffix rule to worktree branches', () => {
        git.worktreePorcelain = porcelain(1);
        const violations = rule('ON').check(ctx('git worktree add ../f -b dean/upgradewp2 origin/main'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('wp<number>');
    });

    // Off a feature branch with no explicit base, the worktree would fork the CURRENT head — a
    // sub-branch. Blocked, and the recovery command must be a WORKTREE command, not `git checkout -b`
    // (which fatals in a worktree).
    it('blocks a worktree add that would fork the current feature branch, recovering with a worktree command', () => {
        git.branch = 'dean/existing';
        git.worktreePorcelain = porcelain(1);
        const violations = rule('ON_NO_SUBBRANCHES').check(ctx('git worktree add ../f -b dean/next'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('git worktree add ../dean-next -b dean/next origin/main');
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

// `git worktree add ../dir <existing-branch>` creates no branch, so the naming/fresh-main rules do
// not apply to it — but the branch it checks out can be DEAD, and neither count cap catches that.
// Left alone, it materializes a whole directory of pre-merge code for the AI to read and plan from.
describe('branch-creation-guard worktree add onto a dead branch', () => {
    beforeEach(() => {
        git.branch = 'main';
        git.behind = 0;
        git.worktreePorcelain = porcelain(0);
    });

    it('blocks adding a worktree onto a branch whose PR is already merged', () => {
        git.cacheJson = cacheWith(['dean/merged']);
        const violations = rule('ON').check(ctx('git worktree add ../old dean/merged'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('is dead');
        expect(violations[0].message).toContain('PR #100 merged');
        // …and hands back the worktree form of the cure, never `git checkout -b`.
        expect(violations[0].message).toContain('git worktree add ../dean-merged -b <new-branch> origin/main');
    });

    it('allows a worktree onto a branch that still holds unmerged work', () => {
        git.cacheJson = cacheWith(['dean/merged'], ['dean/alive']);
        expect(rule('ON').check(ctx('git worktree add ../alive dean/alive')).length).toBe(0);
    });

    // The recommended base is a remote-tracking ref, not a branch — it can never be "dead".
    it('never trips on the recommended origin/main base', () => {
        git.cacheJson = cacheWith(['dean/merged']);
        expect(rule('ON').check(ctx('git worktree add ../fresh origin/main')).length).toBe(0);
        expect(rule('ON').check(ctx('git worktree add ../fresh -b dean/new origin/main')).length).toBe(0);
    });

    // Same fail-open contract as both caps: no cache on disk → no opinion.
    it('fails OPEN when there is no merged-branches cache yet', () => {
        git.cacheJson = null;
        expect(rule('ON').check(ctx('git worktree add ../old dean/merged')).length).toBe(0);
    });
});
