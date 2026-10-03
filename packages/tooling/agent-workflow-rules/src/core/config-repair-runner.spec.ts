
import { policyFixture } from '@webpieces/tooling-testkit';
import { RulePackRegistry } from '@webpieces/rules-config';
const fixtureRuleRegistry = new RulePackRegistry(policyFixture.manifests());
import { policyFixture } from '@webpieces/tooling-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { ExcludePaths, RuleFailError, Option } from '@webpieces/rules-config';

import { prepareLegacyUpgrade } from '@webpieces/rules-config';
import { effectiveBashCwd, isGitOrGhCommand, runBash, run, runRead } from './runner';
import { runRuleCheck } from '@webpieces/hook-runtime';
import { filterByExcludedPaths } from '@webpieces/hook-runtime';
import { GovernedPath } from '@webpieces/hook-runtime';
import { Rule, Violation, BashContext, BlockedResult, NormalizedToolInput, NormalizedEdit } from '@webpieces/hook-runtime';

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
// one with the installer's own seeder (prepareLegacyUpgrade({}, fixtureRuleRegistry) fills every rule with a valid default) rather than
// hand-rolling one that drifts as rules are added. We then (a) arm ONLY the PR-lifecycle policy so
// the tests stay hermetic (branch-state-guard is the one that reads git state and spawns the main-sync
// refresher, so it stays OFF), and (b) set excludePaths per test.
//
// `pr-lifecycle-guard` is a POLICY key covering four classes, and arming it arms all four. That is fine
// here: the other three are pure command-shape blocks that no command in these tests matches, and
// pr-creation-or-push-guard — the one under test — is the only one that can fire.
function writeGuardConfig(root: string, guardsExclude: readonly string[]): void {
    // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
    const config = prepareLegacyUpgrade({}, fixtureRuleRegistry).config as Record<string, any>;
    // seedRule() omits branch-creation-guard's required autoReapMergedBranches — supply it.
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) {
        config.hookGuards[name].mode = name === 'pr-lifecycle-guard' ? 'ON' : 'OFF';
    }
    config.excludePaths = [...guardsExclude];
    policyFixture.declareIn(root);
    policyFixture.writeOwnerConfig(root, config);
}

// End-to-end through runBash: the gate now judges the effective cwd. Real git repos so the
// same-repo boundary check (`--git-common-dir`, via DotWebpieces) is exercised for real, not mocked.
describe('runBash / run — an unloadable config blocks work but never read-only inspection', () => {
    let root: string;

    beforeAll(() => {
        root = specTempDirs.makeReal('wp-cfgbroken-');
        initRepo(root);
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function breakConfig(): void {
        // Exactly the live reproduction: mid-merge, the config holds conflict markers.
        fs.writeFileSync(
            nodePath.join(root, 'webpieces.config.json'),
            '<<<<<<< HEAD\n{ "rules": {} }\n=======\n{ "rules": {} }\n>>>>>>> main\n',
        );
    }

    it('allows `cat webpieces.config.json` while the config is invalid', () => {
        breakConfig();
        expect(runBash('cat webpieces.config.json', root, 'guards', 'claude-code')).toBeNull();
    });

    it('allows grep/sed inspection of the broken file (the tools needed to find the markers)', () => {
        breakConfig();
        expect(
            runBash('grep -n "<<<<<<<" webpieces.config.json', root, 'guards', 'claude-code'),
        ).toBeNull();
        expect(
            runBash("sed -n '1,5p' webpieces.config.json", root, 'guards', 'claude-code'),
        ).toBeNull();
    });

    it('still fails hard on a git command — a broken config ran NO guards, so work stays blocked', () => {
        breakConfig();
        expect(() => runBash('git push origin HEAD', root, 'guards', 'claude-code')).toThrow(
            'could not be parsed as JSON',
        );
    });

    it('still fails hard on a build command (only INSPECTION is carved out, not "harmless-looking")', () => {
        breakConfig();
        expect(() => runBash('pnpm run build-all', root, 'guards', 'claude-code')).toThrow(
            'could not be parsed as JSON',
        );
    });

    it('still blocks WRITES to other files while the config is invalid', () => {
        breakConfig();
        const input = new NormalizedToolInput(nodePath.join(root, 'src', 'x.ts'), [
            new NormalizedEdit('', 'const a = 1;'),
        ]);
        expect(() => run('Write', input, root, 'guards')).toThrow('could not be parsed as JSON');
    });

    it('allows actual Read tools and root repair while JSON is invalid', () => {
        breakConfig();
        expect(runRead(nodePath.join(root, 'webpieces.config.json'), root, 'guards')).toBeNull();
        const input = new NormalizedToolInput(nodePath.join(root, 'webpieces.config.json'), [
            new NormalizedEdit('', '{}'),
        ]);
        expect(run('Write', input, root, 'guards')).toBeNull();
    });

    it('allows exact owner-file and artifact repairs, sync and inspection while owner JSON is invalid', () => {
        writeGuardConfig(root, []);
        const owner = nodePath.join(root, '.webpieces/rules/fixture-0.json');
        fs.writeFileSync(owner, '{');
        const repair = new NormalizedToolInput(owner, [new NormalizedEdit('', '{}')]);
        expect(run('Write', repair, root, 'guards')).toBeNull();
        expect(runRead(owner, root, 'guards')).toBeNull();
        expect(
            runBash('cat .webpieces/rules/fixture-0.json', root, 'guards', 'claude-code'),
        ).toBeNull();
        expect(runBash('pnpm wp-rules-sync', root, 'guards', 'claude-code')).toBeNull();
        for (const filename of [
            '.webpieces/rules.lock.json',
            '.webpieces/instruct-ai/rules-catalog.md',
        ]) {
            expect(
                run(
                    'Write',
                    new NormalizedToolInput(nodePath.join(root, filename), [
                        new NormalizedEdit('', '{}'),
                    ]),
                    root,
                    'guards',
                ),
            ).toBeNull();
        }
        const unrelated = new NormalizedToolInput(
            nodePath.join(root, '.webpieces/rules/undeclared.json'),
            [new NormalizedEdit('', '{}')],
        );
        expect(() => run('Write', unrelated, root, 'guards')).toThrow(
            'Cannot parse rule-pack config',
        );
        expect(() =>
            runBash('pnpm wp-rules-sync && touch src/other.ts', root, 'guards', 'claude-code'),
        ).toThrow('Cannot parse rule-pack config');
        expect(() => runBash('git push origin HEAD', root, 'guards', 'claude-code')).toThrow(
            'Cannot parse rule-pack config',
        );
    });

    it('back to normal once the config is valid again — inspection and guards both behave', () => {
        writeGuardConfig(root, []);
        expect(runBash('cat webpieces.config.json', root, 'guards', 'claude-code')).toBeNull();
        const result = runBash('git push origin HEAD', root, 'guards', 'claude-code');
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
