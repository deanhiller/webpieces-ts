import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, StaleMainBashGuardConfig } from '@webpieces/rules-config';

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
}));

import { StaleMainBashGuardRule } from './stale-main-bash-guard';

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

function rule(): StaleMainBashGuardRule {
    const cfg = new StaleMainBashGuardConfig();
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
        expect(blocked('cat .webpieces/hooks/guard-async-work.log')).toBe(false);
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
        const cfg = new StaleMainBashGuardConfig();
        cfg.mode = 'OFF';
        expect(new StaleMainBashGuardRule(cfg).shouldRun()).toBe(false);
    });
});
