import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { ExcludePaths, RuleFailError } from '@webpieces/rules-config';

import { migrate } from '../bin/setup';
import { effectiveBashCwd, filterByExcludedPaths, isGitOrGhCommand, runRuleCheck, runBash, run } from './runner';
import { Rule, Violation, BashContext, BlockedResult, NormalizedToolInput, NormalizedEdit } from './types';

// filterByExcludedPaths reads only `rule.name` (for the assertions below), so a minimal stand-in is
// enough. `configKey` is carried too because the SIBLING helper filterByMode classifies on that field
// rather than on the name — a stand-in with only a name would classify the guard as a code rule.
function ruleNamed(name: string, configKey: string): Rule {
    return { name, configKey } as unknown as Rule;
}

const codeRule = ruleNamed('max-file-lines', 'max-file-lines');
// A CLASS name whose config key is the branch-state POLICY — the exact pair the collapse creates.
const guard = ruleNamed('feature-branch-guard', 'branch-state-guard');

function names(rules: readonly Rule[]): string[] {
    return rules.map((r: Rule): string => r.name);
}

describe('filterByExcludedPaths', () => {
    // ONE list now: an excluded path is hands-off for code rules and guards alike. The old two-list
    // form let them vary independently; no consumer ever did, and a per-rule carve-out is served by
    // the rule's OWN excludePaths instead.
    it('drops EVERY rule — code rules and guards — on an excluded path', () => {
        const ex = new ExcludePaths(['repositories/**']);
        expect(filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', ex)).toEqual([]);
    });

    it('keeps every rule for a path that matches no exclusion', () => {
        const ex = new ExcludePaths(['repositories/**']);
        const kept = filterByExcludedPaths([codeRule, guard], 'src/app/service.ts', ex);
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    it('keeps every rule when the list is empty (enforce everywhere — the seeded default)', () => {
        const kept = filterByExcludedPaths([codeRule, guard], 'vendor/lib/x.ts', new ExcludePaths([]));
        expect(names(kept)).toEqual(['max-file-lines', 'feature-branch-guard']);
    });

    it('keeps everything when the list is empty even on a would-be-excluded path', () => {
        const kept = filterByExcludedPaths([codeRule, guard], 'repositories/foo/bar.ts', new ExcludePaths([]));
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

    /**
     * Fault C, the JS-side twin of the shim's `pwd`-under-drift test. Orientation is on the L0 list,
     * so it must survive the config-missing block: you have to be able to see which tree you are in
     * BEFORE you can decide where to write the config.
     */
    it('lets read-only orientation through the config-missing block, but not a mutation', () => {
        const dir = tmpDirOutsideRepo();
        for (const cmd of ['pwd', 'git status', 'git rev-parse --show-toplevel', 'git worktree list']) {
            expect(runBash(cmd, dir, 'guards'), `should survive fault C: ${cmd}`).toBeNull();
        }
        for (const cmd of ['git worktree add ../x', 'git worktree prune', 'git status && rm -rf /']) {
            expect(runBash(cmd, dir, 'guards'), `must stay blocked under fault C: ${cmd}`).toBeInstanceOf(BlockedResult);
        }
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

    it('does NOT honour a TRAILING cd — a command before it already ran at the shell cwd', () => {
        // The bypass fix: `git push && cd <exempt>` must NOT resolve to the exempt tree, or the leading
        // root-level push would ride the exempt allow. The first non-cd segment stops the scan.
        expect(effectiveBashCwd('git push origin main && cd repositories/x', '/repo')).toBe('/repo');
        expect(effectiveBashCwd('git status && cd repositories/x && git push', '/repo')).toBe('/repo');
    });

    it('stops at the first non-cd segment even mid-chain', () => {
        // `cd a` counts (leading), but the `echo` breaks the run so the later `cd b` is ignored.
        expect(effectiveBashCwd('cd a && echo hi && cd b', '/repo')).toBe(nodePath.resolve('/repo', 'a'));
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
// hand-rolling one that drifts as rules are added. We then (a) arm ONLY the PR-lifecycle policy so
// the tests stay hermetic (branch-state-guard is the one that reads git state and spawns the main-sync
// refresher, so it stays OFF), and (b) set excludePaths per test.
//
// `pr-lifecycle-guard` is a POLICY key covering four classes, and arming it arms all four. That is fine
// here: the other three are pure command-shape blocks that no command in these tests matches, and
// pr-creation-or-push-guard — the one under test — is the only one that can fire.
function writeGuardConfig(root: string, guardsExclude: readonly string[]): void {
    // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
    const config = migrate({}).config as Record<string, any>;
    // seedRule() omits branch-creation-guard's required autoReapMergedBranches — supply it.
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) {
        config.hookGuards[name].mode = name === 'pr-lifecycle-guard' ? 'ON' : 'OFF';
    }
    config.excludePaths = [...guardsExclude];
    fs.writeFileSync(nodePath.join(root, 'webpieces.config.json'), JSON.stringify(config));
}

// End-to-end through runBash: the gate now judges the effective cwd. Real git repos so the
// same-repo boundary check (`--git-common-dir`, via DotWebpieces) is exercised for real, not mocked.
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
        nestedClone = nodePath.join(outer, 'repositories', 'acme-ai-manager');
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
        // Blocked by force-to-root, which runs BEFORE the bash guards (gitFromSubdirBlock precedes
        // runBashRules) and now judges the cd'd-into directory rather than the shell's own. It used to
        // fall through to the push guard's "gated flow" message because the shell sat at the root.
        // Still blocked either way; the cost is one extra turn — the agent is steered back to the root
        // first, and the gated-flow message lands when it re-runs there.
        expect((result as BlockedResult).report).toContain('Run git/gh commands from the repo root');
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

// Fix A at the gate: a trailing cd into an exempt tree must not exempt a command that already ran at
// the governed root.
describe('runBash — trailing-cd does not bypass the guards (defect A)', () => {
    let outer: string;

    beforeAll(() => {
        outer = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-a-')));
        initRepo(outer);
        fs.mkdirSync(nodePath.join(outer, 'repositories', 'plain'), { recursive: true });
        writeGuardConfig(outer, ['repositories/**']);
    });

    afterAll(() => { fs.rmSync(outer, { recursive: true, force: true }); });

    it('`git push && cd repositories/plain` → BLOCK (push ran at root before the cd)', () => {
        // Still blocked, and now blocked EARLIER: misplacedCdBlock refuses the shape before the push
        // guard is reached, so the report is the cd rule rather than the gated-flow redirect. The
        // property under test is unchanged — a trailing cd buys no exemption for what already ran.
        const result = runBash('git push origin HEAD && cd repositories/plain', outer, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('must come FIRST');
    });

    it('the same push WITHOUT the trailing cd still gets the gated-flow redirect', () => {
        // Keeps the original assertion alive on the shape that can still reach the push guard, so a
        // regression in that redirect cannot hide behind the cd rule firing first.
        const result = runBash('git push origin HEAD', outer, 'guards');
        expect((result as BlockedResult).report).toContain('gated flow');
    });
});

// Fix C: force-to-root must judge where the command ENDS UP, not only the pre-`cd` shell cwd, so a
// `cd <root> && git …` from a nested clone is not blocked with self-contradicting "cd to root" advice.
describe('runBash — force-to-root uses the effective cwd (defect C)', () => {
    let outer: string;
    let nestedClone: string;
    let governedSubdir: string;

    beforeAll(() => {
        outer = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-c-')));
        initRepo(outer);
        nestedClone = nodePath.join(outer, 'repositories', 'clone');
        initRepo(nestedClone);
        governedSubdir = nodePath.join(outer, 'src');
        fs.mkdirSync(governedSubdir, { recursive: true });
        writeGuardConfig(outer, ['repositories/**']);
    });

    afterAll(() => { fs.rmSync(outer, { recursive: true, force: true }); });

    it('shell in a nested clone, `cd <root> && git push` → blocked by the PUSH guard, not force-to-root', () => {
        const result = runBash(`cd ${outer} && git push origin HEAD`, nestedClone, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        const report = (result as BlockedResult).report;
        expect(report).toContain('gated flow');              // the right guard
        expect(report).not.toContain('Run git/gh commands from the repo root');  // NOT force-to-root
    });

    it('at the root, `cd src && git status` (governed subdir) → force-to-root BLOCK', () => {
        // INVERTED deliberately. This used to assert ALLOW, on the reasoning that an in-command `cd`
        // into a governed subdir "must not trip force-to-root when the shell itself is at the root" —
        // but that made the guard answer the same DESTINATION two different ways depending on where
        // the shell happened to start: blocked when stranded in src/, allowed when cd'ing into it.
        //
        // One variable decides it now: the directory the command actually runs in. The guard exists to
        // keep the agent's git work at the root, and an agent that cd's INTO a subdir to run git has
        // the same broken mental model as one stranded there — git behaves identically from any subdir
        // of the repo, so there is no legitimate reason to cd in first.
        const result = runBash(`cd ${governedSubdir} && git status`, outer, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('Run git/gh commands from the repo root');
    });

    it('shell PERSISTED in a governed subdir, bare `git status` (no cd) → force-to-root BLOCK (kept)', () => {
        const result = runBash('git status', governedSubdir, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('Run git/gh commands from the repo root');
    });
});

// Fix B: a push/PR block tells the AI about the exempt-tree escape hatch, but only when such trees are
// configured — and never on other guards.
describe('runBash — push/PR block surfaces the exempt-tree hint (defect B)', () => {
    let outer: string;

    beforeAll(() => {
        outer = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-b-')));
        initRepo(outer);
    });

    afterAll(() => { fs.rmSync(outer, { recursive: true, force: true }); });

    it('appends the exempt trees when excludePaths.guards is non-empty', () => {
        writeGuardConfig(outer, ['repositories/**', 'tools/**']);
        const report = (runBash('git push origin HEAD', outer, 'guards') as BlockedResult).report;
        expect(report).toContain('LITERAL');
        expect(report).toContain('repositories/**');
        expect(report).toContain('tools/**');
    });

    // The hint teaches the shape for the NEXT command; misplacedCdBlock enforces it on this one.
    it('states the one legal shape, not just the remedy', () => {
        writeGuardConfig(outer, ['repositories/**']);
        const report = (runBash('git push origin HEAD', outer, 'guards') as BlockedResult).report;
        expect(report).toContain('cd <literal path> && <work>');
        expect(report).toContain('cd "$DIR"');
    });

    it('omits the hint when no trees are exempt (no noise for repos without exemptions)', () => {
        writeGuardConfig(outer, []);
        const report = (runBash('git push origin HEAD', outer, 'guards') as BlockedResult).report;
        expect(report).toContain('gated flow');   // still the push block
        expect(report).not.toContain('LITERAL');  // but no exempt-tree hint
    });
});

// ONE legal shape for relocating a command. Every command rejected here was already being JUDGED from
// the shell cwd — the rejection replaces a silent misdirect, it does not tighten any verdict.
describe('runBash — a `cd` must come first, with a literal path (misplacedCdBlock)', () => {
    let outer: string;

    beforeAll(() => {
        outer = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-cd-')));
        initRepo(outer);
        writeGuardConfig(outer, ['repositories/**']);
    });

    afterAll(() => { fs.rmSync(outer, { recursive: true, force: true }); });

    const REJECTED: readonly string[] = [
        'WT=/tmp/x; cd "$WT"; git push origin HEAD',   // assignment ends the scan
        'git fetch origin && cd /tmp/x && git push',   // bash pushes in /tmp/x; the guard judged the root
        'git push origin HEAD && cd /tmp/x',           // trailing — harmless, and the scope-escape shape
        'cd "$WT" && git push origin HEAD',            // leading but not literal
        'ls && cd sub && pnpm build',                  // not git at all: the rule is about LOCATION
    ];

    it.each(REJECTED)('rejects: %s', (command: string) => {
        const result = runBash(command, outer, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('must come FIRST');
    });

    const ALLOWED: readonly string[] = [
        'git status',                                  // no cd
        'cd . && git status',                          // leading literal
        `cd ${nodePath.join('/tmp', 'a')} && cd . && git status`,  // a leading RUN is still one shape
        'pnpm build && pnpm test',                     // no cd anywhere
    ];

    it.each(ALLOWED)('does not reject: %s', (command: string) => {
        const result = runBash(command, outer, 'guards');
        if (result !== null) expect((result as BlockedResult).report).not.toContain('must come FIRST');
    });

    it('exempts a heredoc — a commit message about `cd` is prose, not a command', () => {
        const command = `git commit -F - <<'EOF'\nUse git fetch && cd /x && git push\nEOF`;
        const result = runBash(command, outer, 'guards');
        if (result !== null) expect((result as BlockedResult).report).not.toContain('must come FIRST');
    });

    /**
     * The rendered deny has to carry the quoted token through, not just the resolver's return value —
     * this is the surface the human actually reads.
     */
    it('renders the offending `cd` and the accepted one into the report', () => {
        const result = runBash('cd . && mkdir -p pintest && cd pintest && pnpm build', outer, 'guards');
        const report = (result as BlockedResult).report;
        expect(report).toContain('`cd pintest`');
        expect(report).toContain('the leading `cd .` WAS accepted');
    });

    /**
     * "Split it" was the only escape offered, and for the shape that triggered this it is not one: the
     * work DEPENDED on running inside the directory, and a lone `cd` moves nothing the guards judge —
     * which that option concedes in its own parenthetical. The idiom that actually unblocked it was the
     * tool's own directory flag, so the deny names that pattern rather than leaving it to be rediscovered.
     */
    it('offers the directory-flag idiom, not just "split it"', () => {
        const report = (runBash('cd . && mkdir -p x && cd x && pnpm build', outer, 'guards') as BlockedResult).report;
        expect(report).toContain('directory flag');
        expect(report).toContain('git -C <dir>');
        expect(report).toContain('--pack-destination');
    });
});

// A config that will not load must not trap the tools needed to repair it. The hard failure is kept
// for WORK (writes, git, builds — the adapter turns the throw into a deny); only provably-inert
// inspection is let through, so `cat`/`grep`/`sed -n` on webpieces.config.json still work.
describe('runBash / run — an unloadable config blocks work but never read-only inspection', () => {
    let root: string;

    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-cfgbroken-')));
        initRepo(root);
    });

    afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

    function breakConfig(): void {
        // Exactly the live reproduction: mid-merge, the config holds conflict markers.
        fs.writeFileSync(
            nodePath.join(root, 'webpieces.config.json'),
            '<<<<<<< HEAD\n{ "rules": {} }\n=======\n{ "rules": {} }\n>>>>>>> main\n',
        );
    }

    it('allows `cat webpieces.config.json` while the config is invalid', () => {
        breakConfig();
        expect(runBash('cat webpieces.config.json', root, 'guards')).toBeNull();
    });

    it('allows grep/sed inspection of the broken file (the tools needed to find the markers)', () => {
        breakConfig();
        expect(runBash('grep -n "<<<<<<<" webpieces.config.json', root, 'guards')).toBeNull();
        expect(runBash("sed -n '1,5p' webpieces.config.json", root, 'guards')).toBeNull();
    });

    it('still fails hard on a git command — a broken config ran NO guards, so work stays blocked', () => {
        breakConfig();
        expect(() => runBash('git push origin HEAD', root, 'guards')).toThrow('could not be parsed as JSON');
    });

    it('still fails hard on a build command (only INSPECTION is carved out, not "harmless-looking")', () => {
        breakConfig();
        expect(() => runBash('pnpm run build-all', root, 'guards')).toThrow('could not be parsed as JSON');
    });

    it('still blocks WRITES to other files while the config is invalid', () => {
        breakConfig();
        const input = new NormalizedToolInput(nodePath.join(root, 'src', 'x.ts'), [new NormalizedEdit('', 'const a = 1;')]);
        expect(() => run('Write', input, root, 'guards')).toThrow('could not be parsed as JSON');
    });

    it('back to normal once the config is valid again — inspection and guards both behave', () => {
        writeGuardConfig(root, []);
        expect(runBash('cat webpieces.config.json', root, 'guards')).toBeNull();
        const result = runBash('git push origin HEAD', root, 'guards');
        expect(result).toBeInstanceOf(BlockedResult);
    });
});

/**
 * The unconditional Write/Edit PASS for `~/.webpieces/config.json`, beside the one webpieces.config.json
 * already has.
 *
 * That home file is OPTIONAL, but when it exists it is STRICTLY validated (HomeConfigService), so a bad
 * key in it makes a `wp-*` command fail with an instruction to go and edit it. Without this pass a guard
 * could block that edit, wedging the agent inside the failure it was told to repair — the exact wedge
 * webpieces.config.json is immune to. The CONTROL case is what makes this non-vacuous: byte-identical
 * content at an ordinary path is still judged.
 */
describe('run — the ~/.webpieces/config.json carve-out', () => {
    // `axios` trips the shipped no-fetch match-rule, so this content is provably judged somewhere.
    const offending = 'import axios from "axios";\n';
    let homeRoot = '';

    beforeAll(() => {
        homeRoot = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-homepass-')));
        initRepo(homeRoot);
        writeGuardConfig(homeRoot, []);
    });

    it('passes a Write to ~/.webpieces/config.json unconditionally', () => {
        const home = nodePath.join(os.homedir(), '.webpieces', 'config.json');
        const input = new NormalizedToolInput(home, [new NormalizedEdit('', offending)]);
        expect(run('Write', input, homeRoot, 'rules')).toBeNull();
    });

    it('CONTROL — the same content at an ordinary path is still judged', () => {
        const input = new NormalizedToolInput(nodePath.join(homeRoot, 'src', 'x.ts'), [new NormalizedEdit('', offending)]);
        expect(run('Write', input, homeRoot, 'rules')).toBeInstanceOf(BlockedResult);
    });
});
