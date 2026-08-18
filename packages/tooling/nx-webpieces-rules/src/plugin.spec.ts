import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isInsideNestedGitRepo, createCiTarget } from './plugin';
import { BRANCH_IDENTITY_INPUTS } from './branch-identity-inputs';
import { ValidationTargets } from './validation-targets';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-plugin-'));
}

describe('isInsideNestedGitRepo', () => {
    it('is false for a normal monorepo project (no nested .git in its ancestry)', () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, 'packages', 'tooling', 'pr-gate'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'packages/tooling/pr-gate')).toBe(false);
    });

    it('is true for a project that IS a nested git repo root', () => {
        const root = tmpRoot();
        const clone = path.join(root, 'repositories', 'foo');
        fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'repositories/foo')).toBe(true);
    });

    it('is true for a project DEEP inside a nested git repo', () => {
        const root = tmpRoot();
        const clone = path.join(root, 'repositories', 'foo');
        fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
        fs.mkdirSync(path.join(clone, 'packages', 'bar'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'repositories/foo/packages/bar')).toBe(true);
    });

    it('does NOT treat the workspace root\'s own .git as nested', () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'apps/web')).toBe(false);
    });

    it('also treats a `.git` FILE (worktree/submodule) as a boundary', () => {
        const root = tmpRoot();
        const clone = path.join(root, 'repositories', 'wt');
        fs.mkdirSync(clone, { recursive: true });
        fs.writeFileSync(path.join(clone, '.git'), 'gitdir: /somewhere\n');
        expect(isInsideNestedGitRepo(root, 'repositories/wt')).toBe(true);
    });
});

describe('createCiTarget', () => {
    it('always aggregates lint + build + test', () => {
        const ci = createCiTarget([], false);
        expect(ci.executor).toBe('nx:noop');
        expect(ci.dependsOn).toEqual(['lint', 'build', 'test']);
    });

    it('appends the per-project validation gates so ci validates but build stays fast', () => {
        const ci = createCiTarget(
            ['validate-no-file-import-cycles', 'di-graph-generate'],
            false,
        );
        expect(ci.dependsOn).toEqual([
            'lint',
            'build',
            'test',
            'validate-no-file-import-cycles',
            'di-graph-generate',
        ]);
    });

    it('adds the cross-project architecture gate only when the workspace exists', () => {
        const withArch = createCiTarget(['validate-no-file-import-cycles'], true);
        expect(withArch.dependsOn).toContain('architecture:validate-complete');
        const withoutArch = createCiTarget(['validate-no-file-import-cycles'], false);
        expect(withoutArch.dependsOn).not.toContain('architecture:validate-complete');
    });
});

// ---------------------------------------------------------------------------------------------------
// A rule that turnOffRuleWhileOnBranch can switch off produces a BRANCH-DEPENDENT verdict, so a CACHED
// target that runs one must carry the branch in its hash. Without this, a hatched branch caches a green
// under hash H and any later PR that leaves the same files untouched hashes to H and replays it — the
// relaxation escapes the branch that opted in. nx.json's sharedGlobals entry for webpieces.config.json is
// the other half (it busts the cache when a hatch is EDITED); neither half is sufficient alone.
// ---------------------------------------------------------------------------------------------------
describe('branch identity is in the hash of every CACHED rule-running target', () => {
    function hasBranchInputs(inputs: unknown): boolean {
        const list = (inputs ?? []) as { env?: string }[];
        return BRANCH_IDENTITY_INPUTS.every(want => list.some(got => JSON.stringify(got) === JSON.stringify(want)));
    }

    it('ci carries them', () => {
        expect(hasBranchInputs(createCiTarget([], false).inputs)).toBe(true);
    });

    it('the cached workspace validators carry them', () => {
        const targets = new ValidationTargets();
        expect(hasBranchInputs(targets.noCycles().inputs)).toBe(true);
        expect(hasBranchInputs(targets.packageJson().inputs)).toBe(true);
        expect(hasBranchInputs(targets.versionsLocked().inputs)).toBe(true);
    });

    // Scoped, NOT global: an uncached target re-runs anyway, and pushing branch identity into
    // sharedGlobals would make every task in the workspace hash branch-uniquely and destroy cross-branch
    // cache reuse fleet-wide.
    it('an UNCACHED validator is left alone', () => {
        const tsInSrc = new ValidationTargets().tsInSrc();
        expect(tsInSrc.cache).toBe(false);
        expect(hasBranchInputs(tsInSrc.inputs)).toBe(false);
    });

    it('keys off the same env vars getCurrentBranch reads', () => {
        expect(BRANCH_IDENTITY_INPUTS).toEqual([{ env: 'GITHUB_HEAD_REF' }, { env: 'WEBPIECES_BRANCH' }]);
    });
});
