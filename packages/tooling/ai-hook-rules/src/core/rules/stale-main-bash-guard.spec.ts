import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, BranchStateGuardConfig } from '@webpieces/rules-config';

import { BashContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

// Mutable state the mocks read. vi.hoisted so the vi.mock factories can close over it.
//   branch        — what `git rev-parse --abbrev-ref HEAD` reports
//   status        — the cached main-sync-status.json the guard reads
//   dirty         — `git status --porcelain` output (non-empty = dirty tree = fail-open valve)
//   containsExit  — exit code of `git merge-base --is-ancestor <originMain> HEAD`
//                   (0 = up to date, 1 = genuinely behind, 128 = git could not tell → fail-open)
//   branchThrows  — git unavailable entirely (fail-open)
const state = vi.hoisted(() => ({
    branch: 'main',
    status: null as MainSyncStatus | null,
    dirty: '',
    containsExit: 1,
    branchThrows: false,
}));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('--abbrev-ref')) {
            if (state.branchThrows) throw new Error('not a git repository');
            return `${state.branch}\n`;
        }
        if (cmd.includes('status --porcelain')) return state.dirty;
        if (cmd.includes('rev-list --count')) return '18\n';
        return '';
    },
    spawnSync: (): { status: number } => ({ status: state.containsExit }),
}));

vi.mock('@webpieces/rules-config', async (importActual: () => Promise<RulesConfigModule>) => {
    const actual = await importActual();
    return {
        ...actual,
        readMainSyncStatus: (): MainSyncStatus | null => state.status,
    };
});

// Spawning the detached refresher must never run in tests.
vi.mock('../main-sync-refresh', () => ({ triggerMainSyncRefresh: (): void => undefined }));
// The decision log writes to disk; silence it so tests never touch the fs.
vi.mock('../decision-log', () => ({
    logGuardDecision: (): void => undefined,
    GuardDecision: class { constructor(...args: unknown[]) { void args; } },
    // The layer token the guards now stamp on every line. A mock that omits it fails at import,
    // which is the mock telling the truth: this module really does depend on it.
    matrixL2Row: (reason: string) => ({ layer: 'L2', row: reason }),
}));

import { StaleMainBashGuardRule } from './stale-main-bash-guard';

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

function rule(): StaleMainBashGuardRule {
    const cfg = new BranchStateGuardConfig();
    cfg.mode = 'ON';
    return new StaleMainBashGuardRule(cfg);
}

// The State-A cache: on main, localMain != originMain.
function staleMainStatus(over: Partial<MainSyncStatus> = {}): MainSyncStatus {
    const base = new MainSyncStatus('main', false, '', true, 'fork', 'origin-sha', 'head', false, [], 'ts');
    base.localMain = 'local-sha';
    return Object.assign(base, over);
}

function blocked(command: string): boolean {
    return rule().check(ctx(command)).length > 0;
}

// The same guard, for a command that runs somewhere else entirely (a leading `cd` — the only way an
// agent reaches a worktree or a scratchpad, since the harness resets a cwd that left the workspace).
function blockedFrom(command: string, effectiveCwd: string): boolean {
    return rule().check(new BashContext(command, '/repo', effectiveCwd)).length > 0;
}

beforeEach(() => {
    state.branch = 'main';
    state.status = staleMainStatus();
    state.dirty = '';
    state.containsExit = 1;   // origin/main is NOT an ancestor of HEAD → we are behind
    state.branchThrows = false;
});

// The incident: main 18 commits behind, Read blocked as designed, and the agent then ls/grep/cat-ed
// the same stale tree all session because nothing looked at Bash.
describe('stale-main-bash-guard — blocks content reads of the stale tree', () => {
    it('blocks the exact commands from the incident', () => {
        expect(blocked('ls .github/workflows/')).toBe(true);
        expect(blocked('cat .github/workflows/promote-to-prod.yml')).toBe(true);
        expect(blocked('grep -r foo services/')).toBe(true);
    });

    it('blocks the rest of the content-reader family', () => {
        expect(blocked('head -50 src/index.ts')).toBe(true);
        expect(blocked('tail -n 20 package.json')).toBe(true);
        expect(blocked('sed -n 1,40p src/app.ts')).toBe(true);
        expect(blocked('awk "{print}" src/app.ts')).toBe(true);
        expect(blocked('find . -name "*.yml"')).toBe(true);
        expect(blocked('wc -l src/app.ts')).toBe(true);
        expect(blocked('jq .version package.json')).toBe(true);
    });

    it('blocks a bare cwd-walking reader (no path argument at all)', () => {
        expect(blocked('ls')).toBe(true);
        expect(blocked('rg TODO')).toBe(true);      // rg with no path walks the cwd
    });

    it('blocks a reader hidden anywhere in a chain', () => {
        expect(blocked('pnpm install && cat src/app.ts')).toBe(true);
        expect(blocked('mkdir -p out; grep foo src/app.ts')).toBe(true);
    });

    it('blocks git content reads against a LOCAL rev', () => {
        expect(blocked('git grep TODO')).toBe(true);
        expect(blocked('git show HEAD:package.json')).toBe(true);
    });

    it('names the cure and does not claim the whole shell is blocked', () => {
        const message = rule().check(ctx('cat src/app.ts'))[0].message;
        expect(message).toContain('git pull --ff-only origin main');
        expect(message).toContain('18 commit(s) behind');
        expect(message).toContain('Still allowed right now');
    });
});

// The guard must never block the cure, the build, or metadata — a wedged agent is worse than a stale
// one, and everything here was explicitly promised to stay open.
describe('stale-main-bash-guard — never wedges the session', () => {
    it('allows the cure itself', () => {
        expect(blocked('git pull --ff-only origin main')).toBe(false);
        expect(blocked('git fetch --prune origin main')).toBe(false);
        expect(blocked('git pull origin main')).toBe(false);
    });

    it('allows builds, tests and installs', () => {
        expect(blocked('pnpm install')).toBe(false);
        expect(blocked('pnpm run build-all')).toBe(false);
        expect(blocked('npx vitest run')).toBe(false);
    });

    it('allows git and gh METADATA (not file content)', () => {
        expect(blocked('git status')).toBe(false);
        expect(blocked('git log --oneline -20')).toBe(false);
        expect(blocked('git diff --stat')).toBe(false);
        expect(blocked('git show HEAD')).toBe(false);      // a commit view, no <rev>:<path>
        expect(blocked('gh pr list')).toBe(false);
    });

    it('allows a reader CONSUMING A PIPE — those bytes came from metadata, not the tree', () => {
        expect(blocked('git log --oneline | grep fix')).toBe(false);
        expect(blocked('git status --porcelain | wc -l')).toBe(false);
    });

    it('allows reads against the CURRENT upstream tree', () => {
        expect(blocked('git show origin/main:package.json')).toBe(false);
        expect(blocked('git grep TODO origin/main')).toBe(false);
    });

    it('allows reads of paths OUTSIDE the workspace', () => {
        expect(blocked('cat /etc/hosts')).toBe(false);
        expect(blocked('cat ~/.zshrc')).toBe(false);
        expect(blocked('tail -100 /tmp/build.log')).toBe(false);
    });

    it('allows the mode-OFF escape hatch and the guards own logs', () => {
        expect(blocked('cat webpieces.config.json')).toBe(false);
        expect(blocked('cat ./webpieces.config.json')).toBe(false);
        expect(blocked('cat .webpieces/logs/async-refresh/x.log')).toBe(false);
        expect(blocked('cat /repo/webpieces.config.json')).toBe(false);
    });
});

// Same fail-open discipline as every sibling guard: block only on data we are sure of.
describe('stale-main-bash-guard — fail-open valves', () => {
    it('allows when the branch cannot be determined', () => {
        state.branchThrows = true;
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows off main — a merged feature branch is merged-branch-bash-guard s job', () => {
        state.branch = 'dean/feature';
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows with no cache, or a cache computed for another branch', () => {
        state.status = null;
        expect(blocked('cat src/app.ts')).toBe(false);
        state.status = staleMainStatus({ branch: 'dean/feature' });
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows when origin/main is unknown (offline)', () => {
        state.status = staleMainStatus({ originMain: '' });
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows the instant origin/main is an ancestor of HEAD (ancestry, not equality)', () => {
        state.containsExit = 0;
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows when git cannot answer the ancestry question at all', () => {
        state.containsExit = 128;
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows on a DIRTY tree — the pull is not a clean fast-forward, do not trap the rescue', () => {
        state.dirty = ' M src/app.ts\n';
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('does not run at all when mode is OFF', () => {
        const cfg = new BranchStateGuardConfig();
        cfg.mode = 'OFF';
        expect(new StaleMainBashGuardRule(cfg).shouldRun()).toBe(false);
    });
});

/**
 * The 2026-07-30 sighting: a command aimed at the agent's own scratchpad under /private/tmp was
 * blocked because the PRIMARY CLONE's main was behind — and the remedy was to `git pull` that clone,
 * which the agent had been explicitly instructed not to touch. A read that never touches the tree
 * cannot be reading a stale tree.
 */
describe('stale-main-bash-guard — only reads of THIS tree count as stale reads', () => {
    it('allows a read whose paths are all outside the workspace (unchanged)', () => {
        expect(blocked('cat /etc/hosts')).toBe(false);
        expect(blocked('ls -la /Users/dean/.claude/projects/')).toBe(false);
    });

    it('resolves a RELATIVE path against the directory the command runs in, not the workspace root', () => {
        expect(blockedFrom('cd /private/tmp/scratch && cat notes.md', '/private/tmp/scratch')).toBe(false);
        expect(blockedFrom('cd /private/tmp/scratch && ls -la', '/private/tmp/scratch')).toBe(false);
    });

    it('still blocks an ABSOLUTE path back into the tree, from anywhere (no bypass)', () => {
        expect(blockedFrom('cd /private/tmp/scratch && cat /repo/src/app.ts', '/private/tmp/scratch')).toBe(true);
        expect(blockedFrom('cd /private/tmp/scratch && grep -r x /repo/src', '/private/tmp/scratch')).toBe(true);
    });

    it('still blocks a relative read when the command really does run in the tree (no regression)', () => {
        expect(blockedFrom('cat src/app.ts', '/repo')).toBe(true);
        expect(blockedFrom('cd /repo/src && cat app.ts', '/repo/src')).toBe(true);
    });
});

/**
 * The PREVENTIVE half. Everything above fires once the session is already ON a stale main; this
 * stops it getting there.
 *
 * The incident: `git checkout main` onto a main 157 commits behind reverted the @webpieces pin AND
 * `.claude/webpieces/ai-hook.sh` — the drift guard itself — to a copy that reported the drift
 * backwards and named `pnpm install`, which downgraded node_modules and had to be undone by the
 * `git pull` that should have come first. A guard a stale checkout can revert cannot catch one.
 */
describe('stale-main-bash-guard — a bare checkout of main is blocked before it happens', () => {
    it('blocks the bare forms', () => {
        expect(blocked('git checkout main')).toBe(true);
        expect(blocked('git switch main')).toBe(true);
    });

    // The pairing this rule exists to force — and the exact line the post-merge cleanup prescribes.
    it('allows the checkout when the pull rides along in the SAME command', () => {
        expect(blocked('git checkout main && git pull origin main')).toBe(false);
        expect(blocked('git switch main && git pull --ff-only origin main')).toBe(false);
        expect(blocked('gh pr merge --squash && git checkout main && git pull origin main && pnpm wp-cleanup')).toBe(false);
    });

    /**
     * The whole point is that a SEPARATE pull is not good enough: between the two tool calls the
     * session is on a stale main, running a stale shim, with a stale pin — which is the window the
     * incident happened in. Only same-command pairing closes it.
     */
    it('is not satisfied by a pull that is not in this command', () => {
        expect(blocked('git checkout main')).toBe(true);
        expect(blocked('git checkout main; echo done')).toBe(true);
    });

    // Narrow by design: only landing ON the branch. Creating a branch off origin/main is current by
    // construction, a sha is a deliberate historical read, and `--` makes the rest pathspecs.
    it('leaves every other flavour of checkout alone', () => {
        expect(blocked('git checkout -b deanhiller/feat origin/main')).toBe(false);
        expect(blocked('git checkout -B main origin/main')).toBe(false);
        expect(blocked('git switch -c deanhiller/feat origin/main')).toBe(false);
        expect(blocked('git checkout 2b151db')).toBe(false);
        expect(blocked('git checkout -- main')).toBe(false);
        expect(blocked('git checkout -- main.ts')).toBe(false);
        expect(blocked('git checkout feature/main-thing')).toBe(false);
        expect(blocked('git checkout -q feature')).toBe(false);
        expect(blocked('git checkout deanhiller/some-branch')).toBe(false);
    });

    /**
     * Flags do not change which branch you land on, so they must not change the verdict — in EITHER
     * direction. The shared BranchSwitchScan is what makes this rule and redirect-how-to-merge-main
     * agree on the answer; before it, `git checkout -q main` was blocked by that guard as a "feature
     * switch" while this one prescribed the unflagged spelling as the cure.
     */
    it('is flag-tolerant about the branch name', () => {
        expect(blocked('git checkout -q main')).toBe(true);
        expect(blocked('git checkout --quiet main')).toBe(true);
        expect(blocked('git switch -q main')).toBe(true);
        expect(blocked('git checkout -q main && git pull -q origin main')).toBe(false);
        expect(blocked('git switch --quiet main && git pull --ff-only origin main')).toBe(false);
    });

    /**
     * Unconditional, ahead of every fail-open valve below it. Those all ask "is the main we are ON
     * stale?"; this asks about the main we are about to MOVE TO — a different branch, and one no
     * cache can describe yet. So a missing cache, a clean main, or being on a feature branch (the
     * NORMAL case for `git checkout main`) must not wave it through.
     */
    it('fires regardless of the cache, the current branch, or how current the main we are leaving is', () => {
        state.branch = 'deanhiller/feat';
        expect(blocked('git checkout main')).toBe(true);
        state.status = null;
        expect(blocked('git checkout main')).toBe(true);
        state.status = staleMainStatus();
        state.containsExit = 0;      // the main we are LEAVING is perfectly current — irrelevant
        expect(blocked('git checkout main')).toBe(true);
        state.dirty = ' M src/app.ts';
        expect(blocked('git checkout main')).toBe(true);
    });

    // It names the pin/shim revert, because "you'll have stale files" understates it and was not
    // what actually cost the session. The 157-commit narrative behind it is maintainer material and
    // lives in the class docblock — a blocked AI reads this, and only acts on what it can type.
    it('explains that the checkout reverts the guard that would have caught the drift', () => {
        const message = rule().check(ctx('git checkout main'))[0].message;
        expect(message).toContain('@webpieces pin');
        expect(message).toContain('BACKWARDS');
        // Short enough to be read. The prose above the tree-shaped steps is the part that grew.
        expect(message.split('\n')[0].length).toBeLessThan(300);
    });

    /**
     * The PREFERRED fix option must not be a command a SIBLING guard denies. `git checkout main`
     * inside a linked worktree is blocked by redirect-how-to-merge-main (it fatals there), and this
     * hint has no workspace root, so it cannot detect which tree it is talking to. Rendering
     * TreeRecovery's 'unknown' kind is the honest answer: BOTH forms, each labelled with the tree it
     * belongs to — and it comes from the one place tree-shaped cures are written.
     */
    it('does not prefer a cure that is blocked in a linked worktree', () => {
        const preferred = rule().fixHint.fixOptions.filter((o): boolean => o.preferred);
        expect(preferred.length).toBe(1);
        const text = preferred[0].text;
        // Both tree kinds, each named, so no reader takes the wrong one silently.
        expect(text).toContain('in the primary clone:');
        expect(text).toContain('in a linked worktree');
        expect(text).toContain('git checkout main && git pull origin main');
        expect(text).toContain('git fetch origin main');
        // The instruction that is this guard's whole point survives the rewrite.
        expect(text).toContain('the pull must be in the SAME command');
        // The worktree form must NOT be a separate unranked sibling option again — that split is
        // exactly what let a reader take the preferred, tree-blind one and get denied.
        const worktreeOptions = rule().fixHint.fixOptions
            .filter((o): boolean => !o.preferred && o.text.includes('linked worktree'));
        expect(worktreeOptions.length).toBe(0);
    });
});
