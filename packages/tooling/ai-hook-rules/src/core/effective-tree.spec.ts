import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { vi, afterEach } from 'vitest';

import { HomeConfig, HomeConfigService } from '@webpieces/rules-config';
import { migrate } from '../bin/setup';
import { buildBashContext } from './build-context';
import { isAllowed } from '../bin/shim';
import { EffectiveTreeResolver, atRoot } from './effective-tree';
import { runBash } from './runner';
import { BlockedResult } from './types';

/**
 * The bug these lock down: the harness RESETS a cwd that left the workspace, so an agent working in a
 * linked worktree writes `cd <worktree> && …` and the shell cwd the hook is handed is ALWAYS the
 * primary clone. (A `cd` that STAYS inside the workspace persists instead — so the cwd can equally be
 * a subdirectory left behind turns earlier. Neither can be assumed.) Every guard that reasons from
 * that raw cwd judges the wrong tree.
 */

function gitIn(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-b', 'main');
    gitIn(dir, 'config', 'core.hooksPath', '/dev/null');
    gitIn(dir, 'config', 'user.email', 'test@example.com');
    gitIn(dir, 'config', 'user.name', 'test');
    fs.writeFileSync(nodePath.join(dir, 'f.txt'), 'x');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
}

// Same seeder runner.spec uses: a fully valid config with ONLY pr-creation-or-push-guard armed, so
// no other guard reads git state or spawns the detached main-sync refresher.
function writeGuardConfig(root: string): void {
    // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
    const config = migrate({}).config as Record<string, any>;
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) {
        config.hookGuards[name].mode = name === 'pr-creation-or-push-guard' ? 'ON' : 'OFF';
    }
    config.excludePaths = [];
    fs.writeFileSync(nodePath.join(root, 'webpieces.config.json'), JSON.stringify(config));
}

// Every L1 block prints its remedy as an indented `cd '<dir>' && …` line. Pulling it back OUT of the
// report is the only honest way to test the remedy: it asserts what the agent actually reads, not what
// the builder was called with.
function suggestedCommand(report: string): string {
    const line = report.split('\n').find((l: string): boolean => /^\s+cd '/.test(l));
    return line === undefined ? '' : line.trim();
}

// Several tests pin the machine-local home config; none of them may leak into the next test.
afterEach(() => { vi.restoreAllMocks(); });

let primary: string;
let worktree: string;
let agentWorktree: string;
let nestedClone: string;
let outside: string;

beforeAll(() => {
    // realpathSync so paths match `git rev-parse --show-toplevel` (macOS /var → /private/var).
    const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-tree-')));
    primary = nodePath.join(home, 'primary');
    initRepo(primary);
    worktree = nodePath.join(home, 'wt-feature');
    gitIn(primary, 'worktree', 'add', worktree, '-b', 'feature-x');
    // The layout Claude Code itself creates: a linked worktree checked out INSIDE the governed root,
    // at `<repo>/.claude/worktrees/agent-XXXX`. Its git admin dir lives at `<repo>/.git/worktrees/…`,
    // so the checkout's own `.git` is a FILE, exactly like the sibling worktree above.
    agentWorktree = nodePath.join(primary, '.claude', 'worktrees', 'agent-a9d8eab30bdce959d');
    gitIn(primary, 'worktree', 'add', agentWorktree, '-b', 'agent-branch');
    nestedClone = nodePath.join(primary, 'repositories', 'clone');
    initRepo(nestedClone);
    outside = nodePath.join(home, 'scratch');
    fs.mkdirSync(outside, { recursive: true });
});

const resolver = (): EffectiveTreeResolver => new EffectiveTreeResolver();

describe('EffectiveTreeResolver — which tree does this command act on?', () => {

    it('no `cd` at the governed root → the primary clone, unchanged from before', () => {
        const tree = resolver().resolve('git status', primary, primary);
        expect(tree.kind).toBe('primary');
        expect(tree.root).toBe(primary);
        expect(tree.redirected).toBe(false);
    });

    it('`cd <worktree> && …` is judged against THAT WORKTREE, not the shell cwd (the whole bug)', () => {
        const tree = resolver().resolve(`cd ${worktree} && git status`, primary, primary);
        expect(tree.kind).toBe('worktree');
        expect(tree.root).toBe(worktree);
        expect(tree.effectiveCwd).toBe(worktree);
        expect(tree.redirected).toBe(true);
        // …and the shell cwd it was handed is still the primary clone, which is the point.
        expect(tree.shellCwd).toBe(primary);
    });

    it('a linked worktree is MANAGED, not foreign — the guards must still govern it', () => {
        // Before this fix a worktree read as a different git toplevel and so as a FOREIGN repo, which
        // silently disabled EVERY guard for `cd <worktree> && …` commands. That is the opposite error
        // from the one in the report, and just as bad.
        expect(resolver().resolve(`cd ${worktree} && git push`, primary, primary).kind).not.toBe('foreign');
    });

    it('a subdirectory of a worktree still resolves to that worktree ROOT', () => {
        const sub = nodePath.join(worktree, 'src');
        fs.mkdirSync(sub, { recursive: true });
        expect(resolver().resolve(`cd ${sub} && git status`, primary, primary).root).toBe(worktree);
    });

});

/**
 * The bug: a worktree checked out INSIDE the governed root — which is where Claude Code puts every
 * agent worktree, `<repo>/.claude/worktrees/agent-XXXX` — took classify()'s "inside the governed tree"
 * fast path and never asked the worktree registry at all.
 *
 * Measured on the published 0.4.611: `git rev-parse --show-toplevel` answers with the WORKTREE, which
 * is not the governed root, so the fast path's nested-clone branch called it `foreign` — and `foreign`
 * is ALLOW_EXEMPT in runner.ts, i.e. every bash guard silently off for exactly the worktrees the
 * harness creates. The worktree guard, which requires `kind === 'worktree'`, was dead code there.
 *
 * Placement is not tree identity. `--git-common-dir` is: it is identical for every checkout of one repo
 * and different for a nested clone, so it answers the same for both worktree placements.
 */
describe('EffectiveTreeResolver — a worktree INSIDE the governed root (the agent-worktree layout)', () => {

    it('is a WORKTREE, not foreign — placement inside the repo does not make it someone else\'s repo', () => {
        const tree = resolver().resolve(`cd ${agentWorktree} && git status`, primary, primary);
        expect(tree.kind).toBe('worktree');
        expect(tree.root).toBe(agentWorktree);
    });

    it('never reads as `foreign`, so the guards are never silently exempted there', () => {
        expect(resolver().resolve(`cd ${agentWorktree} && git push`, primary, primary).kind).not.toBe('foreign');
    });

    it('a SUBDIRECTORY of it resolves to the worktree root, same as a sibling worktree', () => {
        const sub = nodePath.join(agentWorktree, 'packages');
        fs.mkdirSync(sub, { recursive: true });
        const tree = resolver().resolve(`cd ${sub} && git status`, primary, primary);
        expect(tree.kind).toBe('worktree');
        expect(tree.root).toBe(agentWorktree);
    });

    it('a nested CLONE inside the governed root is still foreign — its shared git dir is its own', () => {
        expect(resolver().resolve(`cd ${nestedClone} && git push`, primary, primary).kind).toBe('foreign');
    });

    it('a nested clone inside a linked WORKTREE is foreign too', () => {
        const cloneInWorktree = nodePath.join(agentWorktree, 'repositories', 'vendored');
        initRepo(cloneInWorktree);
        const tree = resolver().resolve(`cd ${cloneInWorktree} && git push`, primary, primary);
        expect(tree.kind).toBe('foreign');
        expect(tree.root).toBe(cloneInWorktree);
    });

    it('the governed root itself is still `primary` — home is home, whoever else is registered', () => {
        expect(resolver().resolve('git status', primary, primary).kind).toBe('primary');
    });
});

/**
 * A block's remedy must not leave its own condition true.
 *
 * The force-to-root remedy was built as `cd '<root>' && <the ORIGINAL command>`. When the original
 * already led with a `cd` — `cd <somewhere> && git status` — effectiveCwd() resolves the LEADING RUN of
 * `cd`s left to right, so the prefixed line still ends up in `<somewhere>` and the violation SURVIVES.
 * The agent retries, gets the identical block with the prefix doubled, then tripled: structurally
 * non-convergent. (Field sighting: an agent worktree that git could not resolve, so it classified
 * `primary` and force-to-root fired against a `cd <worktree> && …` command.)
 */
describe('EffectiveTreeResolver.remedyAtRoot — a remedy that satisfies its own predicate', () => {
    const root = '/repo';

    it('drops the original leading `cd` run instead of stacking a second one in front of it', () => {
        expect(resolver().remedyAtRoot(root, 'cd /repo/.claude/worktrees/agent-x && git status'))
            .toBe("cd '/repo' && git status");
    });

    it('leaves a command with no leading `cd` exactly as it was', () => {
        expect(resolver().remedyAtRoot(root, 'git status')).toBe("cd '/repo' && git status");
    });

    it('drops a RUN of leading `cd`s, matching what effectiveCwd() consumed', () => {
        expect(resolver().remedyAtRoot(root, 'cd /a && cd /b && git push')).toBe("cd '/repo' && git push");
    });

    it('keeps a mid-line `cd` — only the leading run moved where the command was judged', () => {
        expect(resolver().remedyAtRoot(root, 'git fetch && cd /a && git push'))
            .toBe("cd '/repo' && git fetch && cd /a && git push");
    });

    // THE INVARIANT, asserted rather than argued: whatever the remedy is, running it puts the command
    // at the root — so the block that printed it cannot fire on it again.
    it('the remedy it emits ALWAYS resolves to the root it names (no non-convergent block)', () => {
        const commands = [
            'git status',
            'cd /repo/packages/http && git status',
            'cd /repo/.claude/worktrees/agent-x && git push -u origin HEAD',
            'cd /a && cd /b && gh pr view',
            'git fetch && cd /a && git push',
        ];
        for (const command of commands) {
            const remedy = resolver().remedyAtRoot(root, command);
            expect(resolver().effectiveCwd(remedy, '/somewhere/else')).toBe(root);
        }
    });
});

// ONE legal shape: `cd <literal path> && <work>`. The resolver is unchanged — every command rejected
// below was ALREADY judged from the shell cwd — so this is a silent misdirect becoming a loud rule.
describe('EffectiveTreeResolver.misplacedCd — the one legal shape, everything else refused', () => {

    it('`VAR=…; cd "$VAR"; …` — the shape that reads as a guard malfunction — is rejected', () => {
        expect(resolver().misplacedCd(`WT=${worktree}; cd "$WT"; git push`)).toContain('assignment precedes it');
        // …and the resolver still judges it from the shell cwd, exactly as before: no verdict moved.
        expect(resolver().effectiveCwd(`WT=${worktree}; cd "$WT"; git push`, primary)).toBe(primary);
    });

    it('a non-literal target is rejected wherever it sits, leading run or not', () => {
        expect(resolver().misplacedCd('cd "$WT" && git push')).toContain('not a literal path');
        expect(resolver().misplacedCd('cd ~/repo && git push')).toContain('not a literal path');
        expect(resolver().misplacedCd('cd $(git rev-parse --show-toplevel) && git push')).not.toBeNull();
    });

    it('a MID-LINE `cd` is rejected — bash runs the rest there, the guard does not', () => {
        expect(resolver().misplacedCd(`git fetch && cd ${worktree} && git push`)).toContain('at the FRONT');
    });

    it('a TRAILING `cd` is rejected too — same rule, no carve-out to remember', () => {
        // It is harmless (the work already ran at the root) but it is also the `… && cd <exempt-tree>`
        // scope-escape shape, and one rule with no exceptions is the point.
        expect(resolver().misplacedCd(`git push && cd ${worktree}`)).toContain('at the FRONT');
    });

    it('the legal shape passes: a leading run of literal `cd`s, or no `cd` at all', () => {
        expect(resolver().misplacedCd(`cd ${worktree} && git push`)).toBeNull();
        expect(resolver().misplacedCd(`cd /a && cd ${worktree} && git push`)).toBeNull();
        expect(resolver().misplacedCd('git push')).toBeNull();
        expect(resolver().misplacedCd('pnpm build && pnpm test')).toBeNull();
    });

    it('a HEREDOC is exempt — prose that merely CONTAINS a `cd` is not code', () => {
        // A commit message or doc body tokenizes like a command; rejecting it would block writing about
        // the very rule this implements. Skipping the rejection opens nothing: the location still falls
        // back to the shell cwd.
        const command = `git commit -F - <<'EOF'\nFix: use git fetch && cd /x && git push\nEOF`;
        expect(resolver().misplacedCd(command)).toBeNull();
        expect(resolver().effectiveCwd(command, primary)).toBe(primary);
    });

});

describe('EffectiveTreeResolver — the trees it must NOT claim, and what it hands the guards', () => {
    it('a nested clone under the governed root is still FOREIGN (no regression)', () => {
        const tree = resolver().resolve(`cd ${nestedClone} && git push`, primary, primary);
        expect(tree.kind).toBe('foreign');
    });

    it('a directory in no git repo at all reads as OUTSIDE (the /private/tmp scratchpad case)', () => {
        const tree = resolver().resolve(`cd ${outside} && cat notes.md`, primary, primary);
        expect(tree.kind).toBe('outside');
        expect(tree.effectiveCwd).toBe(outside);
    });

    it('a QUOTED cd is not honoured — prose can never move the judged tree', () => {
        const tree = resolver().resolve(`echo "cd ${worktree} && git push"`, primary, primary);
        expect(tree.root).toBe(primary);
    });

    it('a TRAILING cd does not retroactively move a command that already ran at the root', () => {
        const tree = resolver().resolve(`git push origin HEAD && cd ${worktree}`, primary, primary);
        expect(tree.root).toBe(primary);
    });

    it('ONE resolver: force-to-root and the bash guards get the same root for the same command', () => {
        // The two used to hold separate copies of this logic and could disagree about which tree you
        // were in. They now call the same resolve(), so this is an identity check on that single call.
        const command = `cd ${worktree} && git status`;
        const tree = resolver().resolve(command, primary, primary);
        const guardsRoot = buildBashContext(command, tree).workspaceRoot;
        expect(guardsRoot).toBe(tree.root);
        expect(guardsRoot).toBe(worktree);
    });

    it('the bash context carries the effective cwd, so relative paths resolve in the right tree', () => {
        const command = `cd ${outside} && cat notes.md`;
        const ctx = buildBashContext(command, resolver().resolve(command, primary, primary));
        expect(ctx.effectiveCwd).toBe(outside);
        expect(ctx.governedRoot).toBe(primary);
    });
});

describe('runBash end-to-end — a linked worktree is governed, and steering names the tree', () => {
    let e2ePrimary: string;
    let e2eWorktree: string;
    let e2eAgentWorktree: string;

    beforeAll(() => {
        const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-tree-e2e-')));
        e2ePrimary = nodePath.join(home, 'primary');
        initRepo(e2ePrimary);
        writeGuardConfig(e2ePrimary);
        e2eWorktree = nodePath.join(home, 'wt-feature');
        gitIn(e2ePrimary, 'worktree', 'add', e2eWorktree, '-b', 'feature-x');
        e2eAgentWorktree = nodePath.join(e2ePrimary, '.claude', 'worktrees', 'agent-c0ffee');
        gitIn(e2ePrimary, 'worktree', 'add', e2eAgentWorktree, '-b', 'agent-branch');
    });

    it('`cd <worktree> && git push` is still BLOCKED by the push guard (a worktree is not an escape)', () => {
        const result = runBash(`cd ${e2eWorktree} && git push -u origin feature-x`, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('gated flow');
    });

    /**
     * THE REGRESSION TEST THAT MATTERS. Reproduced live on 0.4.614: the identical
     * `git push --dry-run origin HEAD:refs/heads/…` was BLOCKED from the primary clone and EXECUTED
     * from `.claude/worktrees/probe-l1`. Only `--dry-run` kept it from being a real ungated push.
     */
    it('an IN-REPO agent worktree is governed too — it was ALLOW_EXEMPT as a "foreign repo" before', () => {
        const result = runBash(`cd ${e2eAgentWorktree} && git push -u origin agent-branch`, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('gated flow');
    });

    it('the SAME push is blocked from the primary clone — the two locations now agree', () => {
        const result = runBash(`cd ${e2ePrimary} && git push -u origin main`, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('gated flow');
    });

    it('`whole-repo-build-guard` fires in the worktree too, once the machine has opted in', () => {
        // EXPERIMENTAL and OFF unless ~/.webpieces/config.json says otherwise, so opt in here rather
        // than reading the developer's real preferences. HomeConfig(logCapture, wholeRepoBuildGuard).
        vi.spyOn(HomeConfigService.prototype, 'load').mockReturnValue(new HomeConfig(false, true));
        const result = runBash(`cd ${e2eAgentWorktree} && pnpm run build-all`, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('whole-repo-build-guard');
    });

    it('`git status` inside the worktree is ALLOWED — governed is not the same as blocked', () => {
        expect(runBash(`cd ${e2eAgentWorktree} && git status`, e2ePrimary, 'guards')).toBeNull();
    });

    /**
     * The reaped-worktree deadlock (observed live on 0.4.603): a subagent's worktree was removed
     * mid-session, and every later git call was answered with "you are in a subdirectory" plus a remedy
     * that `cd`-ed straight back into the deleted path.
     */
    it('a REAPED worktree says the directory is GONE, and never steers back into it', () => {
        const dead = nodePath.join(e2ePrimary, '.claude', 'worktrees', 'agent-reaped');
        // NOT `git fetch origin main` — that is on the L0 cure allowlist, which runs ahead of L1 by
        // design so a cure stays reachable from every tree.
        const result = runBash(`cd ${dead} && git status`, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        const report = (result as BlockedResult).report;
        expect(report).toContain('no longer exists');
        expect(report).toContain('UNCOMMITTED work');
        // The old misdiagnosis and the old remedy must both be gone.
        expect(report).not.toContain('not a subdirectory');
        expect(report).not.toContain(`cd ${dead}`);
        expect(report).toContain(`cd '${e2ePrimary}' && git status`);
    });

    /**
     * THE PROPERTY, not the instance: a remedy a guard prints must not be a transformation that leaves
     * the violated predicate true. Both L1 remedies are fed back through the runner here; neither may
     * come back with the block that printed it. This is the general form of the compounding-`cd`
     * deadlock — `cd '<root>' && cd '<root>' && cd <dead> && git …`, which burned three rounds live.
     */
    it('property: an L1 remedy fed back through the runner never re-triggers the guard that printed it', () => {
        const sub = nodePath.join(e2eWorktree, 'src');
        const worktreeSub = nodePath.join(e2eAgentWorktree, 'packages');
        for (const dir of [sub, worktreeSub]) fs.mkdirSync(dir, { recursive: true });
        const dead = nodePath.join(e2ePrimary, '.claude', 'worktrees', 'agent-reaped');
        const commands = [
            `cd ${sub} && git status`,
            `cd ${dead} && git status`,
            `cd ${dead} && pnpm build`,
            `cd ${worktreeSub} && git status`,
        ];
        for (const command of commands) {
            const first = runBash(command, e2ePrimary, 'guards');
            expect(first, command).toBeInstanceOf(BlockedResult);
            const headline = (first as BlockedResult).report.split('\n')[0];
            const remedy = suggestedCommand((first as BlockedResult).report);
            expect(remedy, `no remedy found for ${command}`).not.toBe('');
            const second = runBash(remedy, e2ePrimary, 'guards');
            const secondReport = second instanceof BlockedResult ? second.report : '';
            expect(secondReport.split('\n')[0], `remedy re-triggered its own guard: ${remedy}`)
                .not.toBe(headline);
        }
    });

    it('force-to-root from a worktree SUBDIR prescribes ONE line that is itself at the root', () => {
        const sub = nodePath.join(e2eWorktree, 'src');
        fs.mkdirSync(sub, { recursive: true });
        const command = `cd ${sub} && git status`;
        const result = runBash(command, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        const report = (result as BlockedResult).report;
        // It names the tree it judged (a wrong judgement must be visible, not baffling) …
        expect(report).toContain(`Judged against: ${e2eWorktree}`);
        // … and the remedy REPLACES the offending `cd` rather than prefixing another one in front of
        // it. Prefixing left effectiveCwd in the subdir, so the identical block fired on the remedy.
        // Single-quoted, so it stays one runnable line under a path containing a space.
        expect(report).toContain(`cd '${e2eWorktree}' && git status`);
        expect(report).not.toContain(`&& cd ${sub}`);
    });
});

/**
 * `atRoot()` — the ONE formatter for a remedy that must run in a named directory.
 *
 * WHY THE QUOTES (2026-08-02). It used to emit `cd <root> && <command>` UNQUOTED, which is broken
 * shell the moment the repo lives under `/Users/dean hiller/…`, "Google Drive", "My Documents" or an
 * iCloud path: `cd` gets two arguments and fails before the command ever runs. The L0 allowlist could
 * not have accepted such a line either, so on those machines a fault D/X/K in a linked worktree left
 * NO reachable cure at all.
 *
 * SINGLE quotes, never double: sh expands nothing inside '' — `$(…)`, backticks, `$VAR`, `&&`, `;`,
 * `|` are all literal — so a quoted root can smuggle nothing, by construction. Inside "" a `$` still
 * expands, which is why the double-quoted form is neither emitted nor accepted.
 */
describe('atRoot() emits a remedy that is runnable AND allowlisted', () => {
    const spaced = '/Users/dean hiller/repo';

    it('single-quotes the root so a path with a space stays one argument', () => {
        expect(atRoot(spaced, 'pnpm install')).toBe("cd '/Users/dean hiller/repo' && pnpm install");
    });

    it('quotes ordinary paths the same way — one spelling, no branch to get wrong', () => {
        expect(atRoot('/repo', 'git status')).toBe("cd '/repo' && git status");
    });

    it('never emits DOUBLE quotes (inside "" a $ or backtick would still expand)', () => {
        expect(atRoot('/repo', 'pnpm install')).not.toContain('"');
    });

    /**
     * The pathological root — one containing a single quote itself, which essentially never happens on
     * a macOS/Linux dev machine. We emit it UNQUOTED, exactly as this function always behaved, rather
     * than doing the `'\''` dance: that would render correct sh which the allowlist's `'[^']+'` branch
     * then could NOT match, i.e. a remedy the guard refuses — the deadlock shape this area exists to
     * prevent. Unquoted is no worse than the long-standing status quo for that path.
     */
    it("falls back to the old unquoted form when the root itself contains a single quote", () => {
        expect(atRoot("/Users/o'brien/repo", 'pnpm install')).toBe("cd /Users/o'brien/repo && pnpm install");
    });

    it('produces a line the L0 allowlist ACCEPTS — the round trip that matters', () => {
        expect(isAllowed('Bash', atRoot(spaced, 'pnpm install'), '')).toBe('allow');
        expect(isAllowed('Bash', atRoot(spaced, 'git pull origin main'), '')).toBe('allow');
        expect(isAllowed('Bash', atRoot(spaced, 'pnpm exec wp-upgrade-shim'), '')).toBe('allow');
    });
});
