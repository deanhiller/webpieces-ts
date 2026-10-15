import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { DiffScope } from './diff-scope';
import { RuleFileExclusions, RuleFileScope } from './rule-file-scope';

// #1253: the framework applies path exclusions at DISPATCH — the code-rules runtime runs each rule inside
// a RuleFileScope and DiffScope's listings honour it — so a rule carries no exclusion code of its own.

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null: keep any machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function writeFile(root: string, relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
}

const GENERATED = 'services/api/src/__generated__/graphql.ts';
const HAND_WRITTEN = 'services/api/src/OrderService.ts';
const LEGACY = 'libraries/legacy/src/Old.ts';

describe('RuleFileExclusions — one matcher for both lists', () => {
    it('excludes a path either list matches, and nothing else', () => {
        const exclusions = new RuleFileExclusions('no-any-unknown', ['libraries/legacy/**'], ['**/__generated__/**']);
        expect(exclusions.excludes(GENERATED)).toBe(true);
        expect(exclusions.excludes(LEGACY)).toBe(true);
        expect(exclusions.excludes(HAND_WRITTEN)).toBe(false);
    });

    it('normalizes Windows separators', () => {
        expect(new RuleFileExclusions('r', [], ['**/__generated__/**']).excludes('a\\__generated__\\x.ts')).toBe(true);
    });
});

describe('DiffScope inside a RuleFileScope', () => {
    let root: string;
    let base: string;

    beforeEach(() => {
        root = specTempDirs.makeReal('rule-file-scope-');
        git(root, 'init -q -b main');
        git(root, 'config user.email test@test.com');
        git(root, 'config user.name test');
        writeFile(root, 'README.md', 'x\n');
        git(root, 'add -A');
        git(root, 'commit -q -m base');
        base = git(root, 'rev-parse HEAD');
        // The branch regenerates codegen output AND touches hand-written and legacy code.
        writeFile(root, GENERATED, 'export const x: any = 1;\n');
        writeFile(root, HAND_WRITTEN, 'export const y: any = 1;\n');
        writeFile(root, LEGACY, 'export const z: any = 1;\n');
        git(root, 'add -A');
        git(root, 'commit -q -m change');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const scope = new RuleFileScope();
    const diff = new DiffScope();

    it('lists every changed file outside any rule run', () => {
        expect(diff.getChangedFiles(root, base, 'HEAD').sort()).toEqual([LEGACY, GENERATED, HAND_WRITTEN].sort());
        expect(scope.current()).toBeUndefined();
    });

    it('drops the files a rule run excludes — per-rule and global — and keeps hand-written code', async () => {
        const exclusions = new RuleFileExclusions('no-any-unknown', ['libraries/legacy/**'], ['**/__generated__/**']);
        const listed = await scope.runWithin(exclusions, async () => diff.getChangedFiles(root, base, 'HEAD'));
        expect(listed).toEqual([HAND_WRITTEN]);
        const all = await scope.runWithin(exclusions, async () => diff.getAllFiles(root));
        expect(all).toEqual([HAND_WRITTEN]);
    });

    it('scopes exclusions to ONE rule run — concurrent runs never see each other', async () => {
        const generatedOnly = new RuleFileExclusions('a', [], ['**/__generated__/**']);
        const nothing = new RuleFileExclusions('b', [], []);
        const results = await Promise.all([
            scope.runWithin(generatedOnly, async () => {
                await new Promise((resolve: (v: unknown) => void) => setTimeout(resolve, 5));
                return diff.getChangedFiles(root, base, 'HEAD');
            }),
            scope.runWithin(nothing, async () => diff.getChangedFiles(root, base, 'HEAD')),
        ]);
        expect(results[0].sort()).toEqual([LEGACY, HAND_WRITTEN].sort());
        expect(results[1].sort()).toEqual([LEGACY, GENERATED, HAND_WRITTEN].sort());
    });

    it('outside() lists with no exclusions even inside a rule run', async () => {
        const exclusions = new RuleFileExclusions('r', ['**'], []);
        const listed = await scope.runWithin(exclusions, async () =>
            scope.outside(() => diff.getChangedFiles(root, base, 'HEAD')),
        );
        expect(listed.sort()).toEqual([LEGACY, GENERATED, HAND_WRITTEN].sort());
    });
});
