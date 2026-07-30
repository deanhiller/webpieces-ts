import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { ExcludePaths, RuleFailError } from '@webpieces/rules-config';

import { migrate } from '../bin/setup';
import { effectiveBashCwd, filterByExcludedPaths, isGitOrGhCommand, runRuleCheck, runBash } from './runner';
import { Rule, Violation, BashContext, BlockedResult } from './types';

// The helper only reads `rule.name` to classify a rule as guard vs code rule (via isHookGuard), so
// a minimal stand-in is enough. 'feature-branch-guard' is a hook guard; 'max-file-lines' is a code rule.
function ruleNamed(name: string): Rule {
    return { name } as unknown as Rule;
}

const codeRule = ruleNamed('max-file-lines');
const guard = ruleNamed('feature-branch-guard');

function names(rules: readonly Rule[]): string[] {
    return rules.map((r: Rule): string => r.name);
}

describe('filterByExcludedPaths', () => {
    it('drops code rules on an excluded rules path but keeps guards (lists vary independently)', () => {
        const ex = new ExcludePaths(['repositories/**'], []);
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex);
        expect(names(kept)).toEqual(['feature-branch-guard']);
    });

    it('drops guards on an excluded guards path but keeps code rules (lists vary independently)', () => {
        const ex = new ExcludePaths([], ['repositories/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines']);
    });

    it('keeps every rule for a path that matches no exclusion', () => {
        const ex = new ExcludePaths(['repositories/**'], ['repositories/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'src/app/service.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    it('drops both categories when both lists match the path', () => {
        const ex = new ExcludePaths(['vendor/**'], ['vendor/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'vendor/lib/x.ts', ex);
        expect(kept).toEqual([]);
    });

    it('keeps everything when both lists are empty (default behavior)', () => {
        const ex = new ExcludePaths([], []);
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });
});

describe('runRuleCheck (N-legs: a rule may return violations OR throw; never propagates)', () => {
    const ctx = {} as unknown as BashContext; // a throwing/returning check ignores the context

    function ruleThatThrows(name: string, err: Error): Rule {
        return { name, check: (): readonly Violation[] => { throw err; } } as unknown as Rule;
    }

    it('passes through returned violations unchanged', () => {
        const rule = { name: 'r', check: (): readonly Violation[] => [new Violation(3, 'x', 'msg')] } as unknown as Rule;
        const vs = runRuleCheck(rule, ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.message).toBe('msg');
    });

    it('converts a thrown RuleFailError into a Violation with its line/snippet and folds in fix hints', () => {
        const err = new RuleFailError('no-any-unknown', 'Avoid any here', 42, 'const x: any', ['use unknown', 'add a type']);
        const vs = runRuleCheck(ruleThatThrows('no-any-unknown', err), ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.line).toBe(42);
        expect(vs[0]?.snippet).toBe('const x: any');
        expect(vs[0]?.message).toContain('Avoid any here');
        expect(vs[0]?.message).toContain('Fix: use unknown');
        expect(vs[0]?.message).toContain('Fix: add a type');
    });

    it('converts a thrown plain Error (a bug) into a visible "crashed" Violation, not a propagated throw', () => {
        const vs = runRuleCheck(ruleThatThrows('buggy-rule', new Error('boom')), ctx);
        expect(vs).toHaveLength(1);
        expect(vs[0]?.line).toBe(0);
        expect(vs[0]?.message).toContain("Rule 'buggy-rule' crashed: boom");
    });
});

describe('isGitOrGhCommand (drives force-to-root)', () => {
    it('matches a plain git/gh command', () => {
        expect(isGitOrGhCommand('git commit -m x')).toBe(true);
        expect(isGitOrGhCommand('gh pr create')).toBe(true);
    });

    it('matches git/gh after a shell separator', () => {
        expect(isGitOrGhCommand('cd sub && git status')).toBe(true);
        expect(isGitOrGhCommand('echo hi; git push')).toBe(true);
        expect(isGitOrGhCommand('foo | gh pr list')).toBe(true);
    });

    it('does NOT match words that merely contain git/gh', () => {
        expect(isGitOrGhCommand('echo github.com')).toBe(false);
        expect(isGitOrGhCommand('ls digital/')).toBe(false);
        expect(isGitOrGhCommand('cat gitignore-notes.md')).toBe(false);
    });
});

describe('runBash installer bypass (deadlock escape: installs pass even with no/invalid config)', () => {
    // A dir with NO webpieces.config.json anywhere above it → a normal command is blocked with the
    // CONFIG_MISSING report. Installer commands must slip past that (and past config validation) so
    // `pnpm install` can re-enable the guards when the config is ahead of the installed validator.
    function tmpDirOutsideRepo(): string {
        return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-ai-hook-'));
    }

    it('lets `pnpm install` / `npm i` through (null = allow) where a normal command is blocked', () => {
        const dir = tmpDirOutsideRepo();
        expect(runBash('pnpm install', dir, 'guards')).toBeNull();
        expect(runBash('  npm i --frozen-lockfile ', dir, 'guards')).toBeNull();
        // Contrast: a non-installer command in the same config-less dir is NOT bypassed.
        expect(runBash('ls', dir, 'guards')).toBeInstanceOf(BlockedResult);
    });

    it('does NOT bypass a chained command that merely starts with an installer', () => {
        const dir = tmpDirOutsideRepo();
        // Falls through to config handling instead of short-circuiting to allow.
        expect(runBash('pnpm install && rm -rf /', dir, 'guards')).toBeInstanceOf(BlockedResult);
    });
});

// The bash gate must key its git-boundary and excludePaths decisions off the directory the command
// ACTUALLY runs from (after any in-command `cd`), not the pre-`cd` shell cwd. effectiveBashCwd is
// that derivation; it is the one piece of new logic both defects share.
describe('effectiveBashCwd (resolves the post-`cd` directory the command runs from)', () => {
    it('resolves a leading `cd` relative to the shell cwd', () => {
        expect(effectiveBashCwd('cd repositories/clone && git push', '/repo')).toBe(nodePath.resolve('/repo', 'repositories/clone'));
    });

    it('compounds chained relative cds left to right (matches the shell)', () => {
        // `cd a && cd b` lands in /repo/a/b — the second cd is relative to the first.
        expect(effectiveBashCwd('cd a && cd b && git push', '/repo')).toBe(nodePath.resolve('/repo', 'a', 'b'));
    });

    it('lets a later ABSOLUTE cd win over an earlier one', () => {
        expect(effectiveBashCwd('cd a && cd /elsewhere && git push', '/repo')).toBe('/elsewhere');
    });

    it('honours an absolute cd path', () => {
        expect(effectiveBashCwd('cd /somewhere/else && git push', '/repo')).toBe('/somewhere/else');
    });

    it('handles pushd the same as cd', () => {
        expect(effectiveBashCwd('pushd repositories/clone && git push', '/repo')).toBe(nodePath.resolve('/repo', 'repositories/clone'));
    });

    it('returns the shell cwd unchanged when there is no cd prefix', () => {
        expect(effectiveBashCwd('git push origin HEAD', '/repo')).toBe('/repo');
    });

    it('does NOT treat a QUOTED cd as a real cd — no scope escape via echo', () => {
        // The whole point of routing through CommandScanner: the quoted span is one opaque segment
        // whose first word is `echo`, so the `cd repositories/x` inside it is never picked up.
        expect(effectiveBashCwd('echo "cd repositories/x && git push"', '/repo')).toBe('/repo');
    });

    it('ignores a bare cd with no directory argument', () => {
        expect(effectiveBashCwd('cd && git push', '/repo')).toBe('/repo');
    });
});

function gitIn(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-b', 'main');
    // Temp repos must not run this machine's global hooks.
    gitIn(dir, 'config', 'core.hooksPath', '/dev/null');
    gitIn(dir, 'config', 'user.email', 'test@example.com');
    gitIn(dir, 'config', 'user.name', 'test');
    fs.writeFileSync(nodePath.join(dir, 'f.txt'), 'x');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
}

// loadAndValidate demands a FULLY valid config (pr-gate, match-rules, every rule section), so we build
// one with the installer's own seeder (migrate({}) fills every rule with a valid default) rather than
// hand-rolling one that drifts as rules are added. We then (a) arm ONLY pr-creation-or-push-guard so
// the tests stay hermetic (no other guard reads git state or spawns the main-sync refresher), and
// (b) set excludePaths per test.
function writeGuardConfig(root: string, guardsExclude: readonly string[]): void {
    // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
    const config = migrate({}).config as Record<string, any>;
    // seedRule() omits branch-creation-guard's required autoReapMergedBranches — supply it.
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) {
        config.hookGuards[name].mode = name === 'pr-creation-or-push-guard' ? 'ON' : 'OFF';
    }
    config.excludePaths = { rules: [], guards: [...guardsExclude] };
    fs.writeFileSync(nodePath.join(root, 'webpieces.config.json'), JSON.stringify(config));
}

// End-to-end through runBash: the gate now judges the effective cwd. Real git repos so the
// gitToplevel boundary check is exercised for real, not mocked.
describe('runBash — foreign-repo boundary and excludePaths on the bash path (defects 1 & 2)', () => {
    // The governed repo (outer) + a separate git clone nested under repositories/, plus a plain
    // (non-git) subdir also under repositories/. Built once; excludePaths are rewritten per test.
    let outer: string;
    let nestedClone: string;
    let plainSubdir: string;

    beforeAll(() => {
        // realpathSync so the dir matches `git rev-parse --show-toplevel` — on macOS os.tmpdir() is
        // /var/... which git reports as its /private/var/... target; without this the foreign-repo
        // check (path.resolve gitRoot vs workspaceRoot) sees a spurious mismatch and allows everything.
        outer = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-outer-')));
        initRepo(outer);
        nestedClone = nodePath.join(outer, 'repositories', 'onetablet-ai-manager');
        initRepo(nestedClone);       // its OWN git repo → a different toplevel than `outer`
        plainSubdir = nodePath.join(outer, 'repositories', 'plain');
        fs.mkdirSync(plainSubdir, { recursive: true });   // NOT a git repo of its own
    });

    afterAll(() => {
        fs.rmSync(outer, { recursive: true, force: true });
    });

    it('1: `cd <nested clone> && git push` from the outer root → ALLOW (defect 1)', () => {
        writeGuardConfig(outer, ['repositories/**', 'tools/**']);
        // Shell cwd is the OUTER root — the pre-`cd` cwd that used to defeat the foreign-repo escape.
        expect(runBash(`cd ${nestedClone} && git push -u origin feature/x`, outer, 'guards')).toBeNull();
    });

    it('2: same, with excludePaths.guards empty — foreign-repo rule alone suffices → ALLOW', () => {
        writeGuardConfig(outer, []);
        expect(runBash(`cd ${nestedClone} && git push -u origin feature/x`, outer, 'guards')).toBeNull();
    });

    it('3: `cd repositories/plain && git push` where plain is NOT its own repo but IS excluded → ALLOW (defect 2)', () => {
        writeGuardConfig(outer, ['repositories/**']);
        // Same git toplevel as outer (foreign check does not fire), so this exercises excludePaths alone.
        expect(runBash(`cd ${plainSubdir} && git push -u origin feature/x`, outer, 'guards')).toBeNull();
    });

    it('4: plain `git push` at the governed repo root → BLOCK (no regression)', () => {
        writeGuardConfig(outer, ['repositories/**']);
        const result = runBash('git push origin HEAD', outer, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('gated flow');
    });

    it('5: `cd repositories/plain && git push` when NOT excluded and sharing the outer git root → BLOCK', () => {
        writeGuardConfig(outer, []);       // plain is a subdir of the governed repo, no exclusion
        const result = runBash(`cd ${plainSubdir} && git push origin HEAD`, outer, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('gated flow');
    });

    it('6: `echo "cd repositories/plain && git push"` is NOT waved through via the quoted cd', () => {
        // The quoted cd must not resolve the effective cwd into the excluded tree, AND the quoted
        // `git push` is stripped from commandCode so the push guard sees a plain echo → allowed as the
        // no-op it is (the point is it is not the excluded-path BYPASS an unquoted cd would grant).
        writeGuardConfig(outer, ['repositories/**']);
        expect(effectiveBashCwd('echo "cd repositories/plain && git push"', outer)).toBe(outer);
        expect(runBash('echo "cd repositories/plain && git push"', outer, 'guards')).toBeNull();
    });
});
