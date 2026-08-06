import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

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

let primary: string;
let worktree: string;
let nestedClone: string;
let outside: string;

beforeAll(() => {
    // realpathSync so paths match `git rev-parse --show-toplevel` (macOS /var → /private/var).
    const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-tree-')));
    primary = nodePath.join(home, 'primary');
    initRepo(primary);
    worktree = nodePath.join(home, 'wt-feature');
    gitIn(primary, 'worktree', 'add', worktree, '-b', 'feature-x');
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

// The resolver stays strict; only the DIAGNOSIS is new. Every case below already resolved to the
// governed root before this — the question is whether the message can say WHY.
describe('EffectiveTreeResolver.unresolvedCd — naming the `cd` that did not count', () => {

    it('`VAR=…; cd "$VAR"; …` — the shape that reads as a guard malfunction — is named on both counts', () => {
        const reason = resolver().unresolvedCd(`WT=${worktree}; cd "$WT"; git push`);
        expect(reason).toContain('assignment precedes it');
        expect(reason).toContain('not a literal path');
        // …and the resolver itself is unchanged: still judged from the shell cwd.
        expect(resolver().effectiveCwd(`WT=${worktree}; cd "$WT"; git push`, primary)).toBe(primary);
    });

    it('a leading `cd` with a variable target is named even though it WAS reached', () => {
        expect(resolver().unresolvedCd('cd "$WT" && git push')).toContain('not a literal path');
        expect(resolver().unresolvedCd('cd ~/repo && git push')).toContain('not a literal path');
    });

    it('a literal leading `cd` has nothing to explain', () => {
        expect(resolver().unresolvedCd(`cd ${worktree} && git push`)).toBeNull();
        expect(resolver().unresolvedCd('git push')).toBeNull();
    });

    it('a `cd` AFTER a real command is silent — there "put it in front" would be wrong advice', () => {
        // This is the anti-smuggling case: `… && cd <exempt-tree>` must not exempt the whole line, and
        // the resolver refusing it is intended behaviour, not a near-miss to coach the agent out of.
        expect(resolver().unresolvedCd(`git push && cd ${worktree}`)).toBeNull();
        expect(resolver().unresolvedCd('git push && cd "$WT"')).toBeNull();
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

    beforeAll(() => {
        const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-tree-e2e-')));
        e2ePrimary = nodePath.join(home, 'primary');
        initRepo(e2ePrimary);
        writeGuardConfig(e2ePrimary);
        e2eWorktree = nodePath.join(home, 'wt-feature');
        gitIn(e2ePrimary, 'worktree', 'add', e2eWorktree, '-b', 'feature-x');
    });

    it('`cd <worktree> && git push` is still BLOCKED by the push guard (a worktree is not an escape)', () => {
        const result = runBash(`cd ${e2eWorktree} && git push -u origin feature-x`, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('gated flow');
    });

    it('force-to-root from a worktree SUBDIR prescribes one runnable `cd <root> && <original>` line', () => {
        const sub = nodePath.join(e2eWorktree, 'src');
        fs.mkdirSync(sub, { recursive: true });
        const command = `cd ${sub} && git status`;
        const result = runBash(command, e2ePrimary, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        const report = (result as BlockedResult).report;
        // It names the tree it judged (a wrong judgement must be visible, not baffling) …
        expect(report).toContain(`Judged against: ${e2eWorktree}`);
        // … and the remedy is the exact command to run, not "cd first, then re-run". Single-quoted,
        // so it is still one runnable line when the tree lives under a path containing a space.
        expect(report).toContain(`cd '${e2eWorktree}' && ${command}`);
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
