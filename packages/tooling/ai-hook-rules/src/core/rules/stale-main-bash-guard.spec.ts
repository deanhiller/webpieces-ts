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

    /*
     * The message names the STALENESS — which is what the guard's name promised — and the cure is a
     * new branch, because that is the form that works on a dirty tree and moves the work somewhere
     * reviewable at the same time. No commit count: an agent told "18 commits behind" reaches for a
     * pull, lands on a CURRENT main, and is still on main.
     */
    it('names the staleness as the finding, and the cure is a new branch', () => {
        const message = rule().check(ctx('cat src/app.ts'))[0].message;
        expect(message).toContain('local `main` is BEHIND origin/main');
        expect(message).toContain('git checkout -b <new-branch> origin/main');
        expect(message).not.toContain('commit(s) behind');
    });

    /*
     * What the text must still say, and what it must no longer say.
     *
     * KEEPS: reading main to PLAN is legitimate; the FEATURE BRANCH is the unit of work; the cure
     * fetches, so it makes the reads true as well as moving you off main.
     *
     * DROPS, because it is now FALSE: "whether or not it is current". A current main is not blocked at
     * all — the guard fires only once being behind is established — and a refusal that claimed
     * otherwise was unanswerable on a main the prescribed cleanup command had just pulled.
     */
    it('says reading-to-plan is fine, names the feature branch as the unit of work, and no longer claims a CURRENT main is blocked', () => {
        const message = rule().check(ctx('cat src/app.ts'))[0].message;
        expect(message).toContain('reading main to PLAN is fine');
        expect(message).toContain('The feature branch is the unit of work');
        expect(message).toContain('the cure fetches');
        expect(message).toContain('A CURRENT main is not blocked');
        // The two sentences from the branch-only era, gone rather than softened.
        expect(message).not.toContain('whether or not it is current');
        expect(message).not.toContain('`main` is not a place to work');
    });

    /*
     * The matrix pointer is BEST-EFFORT: this workspace root does not exist, so the doc cannot be
     * written and the pointer is correctly empty. What must survive that is the deny itself — a guard
     * whose doc delivery failed still has to say what to do. (The pointer's own content is pinned in
     * l2-matrix.spec.ts, where the path is supplied directly.)
     */
    it('degrades to the plain deny when the matrix doc cannot be written', () => {
        const message = rule().check(ctx('cat src/app.ts'))[0].message;
        expect(message).not.toContain('webpieces.branch-state-matrix.md');
        expect(message).toContain('git checkout -b <new-branch> origin/main');
    });
});

/**
 * ONE SPELLING of "make local `main` current", and it is the one CLAUDE.md names.
 *
 * Fleet-wide this rule handed agents FOUR refresh-main cures across 238 prescriptions, and
 * `pnpm wp-checkout-clean-main` — the command CLAUDE.md names, and the only one that also sweeps the
 * orphan directories — appeared in 6 of them. The other 231 prescribed the hand-rolled pair CLAUDE.md
 * explicitly forbids, so agents caught between the guard and the instructions improvised hybrids of
 * both, four distinct spellings observed, one blocked round trip each. A cure is an instruction the AI
 * follows LITERALLY; the retired spellings are gone rather than softened.
 */
describe('stale-main-bash-guard — one refresh-main cure, and it is the prescribed one', () => {
    const RETIRED = ['git pull origin main', 'git pull --ff-only origin main', 'git checkout main && git pull origin main'];

    it('names none of the retired spellings in any fix option', () => {
        for (const option of rule().fixHint.fixOptions) {
            for (const spelling of RETIRED) expect(option.text, spelling).not.toContain(spelling);
        }
    });

    it('names none of them in either block message', () => {
        const messages = [
            rule().check(ctx('cat src/app.ts'))[0].message,
            rule().check(ctx('git checkout main'))[0].message,
            rule().check(ctx('pnpm wp-checkout-clean-main; cat src/app.ts'))[0].message,
        ];
        for (const message of messages) {
            for (const spelling of RETIRED) expect(message, spelling).not.toContain(spelling);
        }
    });

    // The BRANCH-OFF cure is a different intent and is deliberately untouched — it works on a dirty
    // tree, where refreshing `main` in place does not, so collapsing the two would hand an agent with
    // edits in flight a cure it cannot run.
    it('keeps branching off origin/main as its own, separate cure', () => {
        expect(rule().check(ctx('cat src/app.ts'))[0].message).toContain('git checkout -b <new-branch> origin/main');
    });
});

/**
 * COMPOSITION — `<cure> && <work>` is allowed, `<cure> ; <work>` is not.
 *
 * Both shapes are lifted from the fleet audit (docs/audit/2026-08-24-mon-wed.md §3): the same agent,
 * blocked on a stale `main`, bundled cure and work in one call sixteen times across four distinct
 * spellings. `&&` was refused for nothing — the shell already guarantees the work is skipped when the
 * cure fails — while `;` genuinely runs the work on still-stale content, in 7 of 9 cases with the cure
 * silenced by `>/dev/null 2>&1` as well.
 */
describe('stale-main-bash-guard — the cure may be composed with the work, but only with &&', () => {
    it('ALLOWS a cure joined to the work by && — the shell short-circuits', () => {
        expect(blocked('pnpm wp-checkout-clean-main && cat src/app.ts')).toBe(false);
        expect(blocked('git pull --ff-only origin main && cat src/app.ts')).toBe(false);
        expect(blocked('git pull origin main && pnpm run build-all')).toBe(false);
    });

    // The exact line from the audit, `2>&1 | tail -1` and all. An agent bounds tool output by reflex,
    // and a filter a pipe fed cannot touch the tree — so it must not veto the chain.
    it('ALLOWS the piped-and-fetch-led form agents actually type', () => {
        expect(blocked("git fetch --prune origin main -q && git pull --ff-only origin main 2>&1 | tail -1 && sed -n '30,75p' src/app.ts")).toBe(false);
        expect(blocked("cd /repo && pnpm wp-checkout-clean-main >/dev/null 2>&1 && sed -n '1,5p' src/app.ts")).toBe(false);
    });

    it('REFUSES the same cure joined by ; — the work runs even if the pull fails', () => {
        expect(blocked("pnpm wp-checkout-clean-main >/dev/null 2>&1; git log --oneline -1; sed -n '598,612p' eslint.config.mjs")).toBe(true);
        expect(blocked('git pull --ff-only origin main 2>&1 | tail -1; cat src/app.ts')).toBe(true);
        expect(blocked('pnpm wp-checkout-clean-main || cat src/app.ts')).toBe(true);
    });

    // The fix is a ONE-CHARACTER edit, so the message says which character was typed. An agent told
    // only "use &&" has to diff the two spellings itself to find where.
    it('names the operator that was used, and hands over the && spelling', () => {
        const message = rule().check(ctx('pnpm wp-checkout-clean-main >/dev/null 2>&1; cat src/app.ts'))[0].message;
        expect(message).toContain('Your cure is joined with `;`');
        expect(message).toContain('the work runs even if the pull fails');
        expect(message).toContain('pnpm wp-checkout-clean-main && <your command>');
        expect(message).toContain('Or run the cure alone and re-issue your command in the next call.');

        const orMessage = rule().check(ctx('git pull origin main || cat src/app.ts'))[0].message;
        expect(orMessage).toContain('Your cure is joined with `||`');
    });

    /*
     * A `git fetch` does NOT cure a stale `main` — it moves the remote-tracking ref and leaves local
     * `main` exactly as far behind — so there is nothing for the `&&` to short-circuit and the command
     * gets the ordinary row 6 block, whose message says what a fetch alone does not fix.
     */
    it('does not accept a bare fetch as the cure — it advances nothing local', () => {
        expect(blocked('git fetch origin main && cat src/app.ts')).toBe(true);
        const message = rule().check(ctx('git fetch origin main && cat src/app.ts'))[0].message;
        expect(message).toContain('local `main` is BEHIND origin/main');
        expect(message).not.toContain('Your cure is joined with');
    });

    // A command that merely OPENS with something allowlisted is not cure-prefixed. Only a segment that
    // brings local main forward opens the composition door.
    it('is not opened by any allowlisted first segment', () => {
        expect(blocked('git status --porcelain | head && cat src/app.ts')).toBe(true);
        expect(blocked('pnpm install && cat src/app.ts')).toBe(true);
        expect(blocked('pnpm wp-cleanup && cat src/app.ts')).toBe(true);
    });

    // On a CURRENT main nothing here fires at all — composition is judged only inside row 6's state.
    it('is only consulted once main is established BEHIND', () => {
        state.containsExit = 0;
        expect(blocked("pnpm wp-checkout-clean-main; sed -n '1,5p' src/app.ts")).toBe(false);
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

    /*
     * THE POLARITY FLIP. Builds and tests used to be allowed on `main` because the guard only hunted
     * content READS. They are blocked now, and the doc's skip-list section already said they should
     * be: "there is no point running them on `main` or on a dead branch." Installs stay allowed —
     * they are on the skip list because a broken install is a state you must be able to repair from
     * wherever you are standing.
     */
    it('blocks builds and tests on main, but never the install that repairs the tree', () => {
        expect(blocked('pnpm install')).toBe(false);
        expect(blocked('pnpm run build-all')).toBe(true);
        expect(blocked('npx vitest run')).toBe(true);
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

    /*
     * Reading UPSTREAM is exactly what a blocked agent should be doing, so both git spellings of it
     * stay open — and they are the reason `show` and `grep` sit on the allowlist at all, with
     * ContentReadScan rejecting their local-rev forms one check earlier.
     */
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

/**
 * THE WIDENED SKIP LIST. The principle is one question — does this read or write repo CONTENT? — and
 * `gh` and `curl`/`wget` answer no: they talk to GitHub and to the network. Before this, `gh pr close`
 * and `curl` were denied on a stale main by a guard that had nothing to say about either.
 */
describe('stale-main-bash-guard — the skip list covers what cannot touch the tree', () => {
    it('allows gh GENERALLY, not just the read-only inspections', () => {
        expect(blocked('gh pr close 123')).toBe(false);
        expect(blocked('gh pr comment 123 --body hi')).toBe(false);
        expect(blocked('gh api repos/o/r/pulls')).toBe(false);
        expect(blocked('gh run watch 55')).toBe(false);
        expect(blocked('gh pr view 1 && gh issue list')).toBe(false);
    });

    it('still denies the gh subcommands that write LOCAL files', () => {
        expect(blocked('gh repo clone o/r')).toBe(true);
        expect(blocked('gh pr checkout 123')).toBe(true);
        expect(blocked('gh run download 55')).toBe(true);
    });

    it('allows curl and wget', () => {
        expect(blocked('curl -s https://example.com/health')).toBe(false);
        expect(blocked('wget https://example.com/x.json')).toBe(false);
        expect(blocked('curl -s https://example.com | jq .version')).toBe(false);
    });

    it('denies the fetch forms that write a named local file', () => {
        expect(blocked('curl -o src/app.ts https://example.com/x')).toBe(true);
        expect(blocked('curl https://example.com/x > src/app.ts')).toBe(true);
        expect(blocked('gh api repos/o/r > out.json')).toBe(true);
    });

    // Every segment must pass — a network client cannot launder the command it is chained to.
    it('does not launder a blocked segment chained to an allowed one', () => {
        expect(blocked('curl -s https://example.com/x && cat src/app.ts')).toBe(true);
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

    /*
     * THE CACHE VALVES ARE BACK, and their return is the change. The block means "what you would read
     * here is out of date", so it can only fire on a freshness we have ESTABLISHED. Unknown → allow,
     * logged ALLOW_FAIL_OPEN. Current → allow. Both used to block, from the branch alone.
     */
    it('allows with NO cache at all — the first Bash call of a session cannot know main is behind', () => {
        state.status = null;
        expect(blocked('cat src/app.ts')).toBe(false);
        expect(blocked('pnpm run build-all')).toBe(false);
    });

    it('allows when origin/main is unknown (offline) — nothing to compare against', () => {
        state.status = staleMainStatus({ originMain: '' });
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    it('allows when the cache holds another branch — a shape bug degrades to an allow', () => {
        state.status = staleMainStatus({ branch: 'dean/other' });
        expect(blocked('cat src/app.ts')).toBe(false);
    });

    /*
     * THE POST-CURE DEAD END, which is why this whole change exists: `pnpm wp-checkout-clean-main`
     * leaves you on a perfectly current main, and the guard whose name says STALE then refused
     * everything off a narrow allowlist. WRITES here are still blocked — by feature-branch-guard, which
     * is unconditional on purpose (see its docblock).
     */
    it('allows EVERYTHING on a main that is current — including a build and an install', () => {
        state.containsExit = 0;   // the cached origin/main IS an ancestor of HEAD
        expect(blocked('cat src/app.ts')).toBe(false);
        expect(blocked('pnpm run build-all')).toBe(false);
        expect(blocked('npx vitest run')).toBe(false);
        expect(blocked('gh pr close 123')).toBe(false);
    });

    /*
     * No dirty valve, and none is needed. The cure printed here is `git checkout -b`, which CARRIES
     * uncommitted work onto the new branch — so a dirty tree traps nobody.
     */
    it('blocks on a DIRTY tree when main is behind — `git checkout -b` carries the work with you', () => {
        state.dirty = ' M src/app.ts\n';
        expect(blocked('cat src/app.ts')).toBe(true);
    });

    it('still allows every command that gets you OUT, dirty tree or not', () => {
        state.dirty = ' M src/app.ts\n';
        state.status = null;
        expect(blocked('git checkout -b dean/x origin/main')).toBe(false);
        expect(blocked('git stash')).toBe(false);
        expect(blocked('git status')).toBe(false);
        expect(blocked('pnpm wp-cleanup')).toBe(false);
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
        // Run from the FEATURE branch, which is where you actually are when you land a PR. On `main`
        // row 5 would block it anyway, on the strength of the un-allowlisted `gh pr merge` segment.
        state.branch = 'deanhiller/feat';
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
        // The primary-clone form is `pnpm wp-checkout-clean-main` — the raw pair with wp-cleanup and
        // the orphan-directory sweep welded on. The pair is still legal git and is still the L0
        // recovery cure; the workflow layer simply stops teaching it (see TreeRecovery).
        expect(text).toContain('pnpm wp-checkout-clean-main');
        expect(text).not.toContain('git checkout main && git pull origin main');
        expect(text).toContain('git fetch origin main');
        // The instruction that is this guard's whole point survives the rewrite — now stated for the
        // agent that hand-rolls the git anyway, since the prescribed form has nothing to chain.
        expect(text).toContain('the pull must be in the SAME command');
        // The worktree form must NOT be a separate unranked sibling option again — that split is
        // exactly what let a reader take the preferred, tree-blind one and get denied.
        const worktreeOptions = rule().fixHint.fixOptions
            .filter((o): boolean => !o.preferred && o.text.includes('linked worktree'));
        expect(worktreeOptions.length).toBe(0);
    });
});
