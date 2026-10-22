import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitResultDto } from '@webpieces/tooling-common';
import { specTempDirs } from '@webpieces/tooling-testkit';

import { RulesConfigFeature } from './__tests__/rules-config-feature';
import { DiffScope } from './diff-scope';
import { RuleFileExclusions, RuleFileScope } from './rule-file-scope';

// #1253: the framework applies path exclusions at DISPATCH — the code-rules runtime runs each rule inside
// a RuleFileScope and DiffScope's listings honour it — so a rule carries no exclusion code of its own.

const GENERATED = 'services/api/src/__generated__/graphql.ts';
const HAND_WRITTEN = 'services/api/src/OrderService.ts';
const LEGACY = 'libraries/legacy/src/Old.ts';
const BASE = 'base-sha';
// What git reports the branch changed: it regenerates codegen output AND touches hand-written and legacy code.
const CHANGED = `${GENERATED}\n${HAND_WRITTEN}\n${LEGACY}\n`;

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
    let feature: RulesConfigFeature;
    let diff: DiffScope;
    const scope = new RuleFileScope();

    beforeEach(async () => {
        // The files exist on disk (getAllFiles drops a listed path that is gone); git's answers are scripted.
        root = specTempDirs.makeReal('rule-file-scope-');
        for (const file of [GENERATED, HAND_WRITTEN, LEGACY]) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), 'export const x: any = 1;\n');
        }
        feature = await RulesConfigFeature.create();
        feature.git.respond(['diff', '--name-only', '--diff-filter=d', BASE, 'HEAD', '--', '*.ts', '*.tsx'], feature.git.ok(CHANGED));
        feature.git.respond(['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'], feature.git.ok(CHANGED));
        diff = feature.container.get(DiffScope);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('lists every changed file outside any rule run', async () => {
        expect((await diff.getChangedFiles(root, BASE, 'HEAD')).sort()).toEqual([LEGACY, GENERATED, HAND_WRITTEN].sort());
        expect(scope.current()).toBeUndefined();
    });

    it('drops the files a rule run excludes — per-rule and global — and keeps hand-written code', async () => {
        const exclusions = new RuleFileExclusions('no-any-unknown', ['libraries/legacy/**'], ['**/__generated__/**']);
        const listed = await scope.runWithin(exclusions, async () => diff.getChangedFiles(root, BASE, 'HEAD'));
        expect(listed).toEqual([HAND_WRITTEN]);
        const all = await scope.runWithin(exclusions, async () => diff.getAllFiles(root));
        expect(all).toEqual([HAND_WRITTEN]);
    });

    it('scopes exclusions to ONE rule run — concurrent runs never see each other', async () => {
        // The FIRST run's `git diff` is held in flight by the test, so the second run starts, finishes and
        // is filtered while the first is still waiting — then the first is let go. No real time passes.
        let release: (result: GitResultDto) => void = (): void => undefined;
        const held = new Promise<GitResultDto>((resolve: (result: GitResultDto) => void): void => { release = resolve; });
        const changed = ['diff', '--name-only', '--diff-filter=d', BASE, 'HEAD', '--', '*.ts', '*.tsx'];
        // A fresh program, so these two answers are the only ones scripted for that diff, in this order.
        feature = await RulesConfigFeature.create();
        feature.git.respond(changed, held);
        feature.git.respond(changed, feature.git.ok(CHANGED));
        diff = feature.container.get(DiffScope);
        const generatedOnly = new RuleFileExclusions('a', [], ['**/__generated__/**']);
        const nothing = new RuleFileExclusions('b', [], []);

        const first = scope.runWithin(generatedOnly, async () => diff.getChangedFiles(root, BASE, 'HEAD'));
        const second = await scope.runWithin(nothing, async () => diff.getChangedFiles(root, BASE, 'HEAD'));
        release(feature.git.ok(CHANGED));
        const results = [await first, second];

        expect(results[0].sort()).toEqual([LEGACY, HAND_WRITTEN].sort());
        expect(results[1].sort()).toEqual([LEGACY, GENERATED, HAND_WRITTEN].sort());
    });

    it('outside() lists with no exclusions even inside a rule run', async () => {
        const exclusions = new RuleFileExclusions('r', ['**'], []);
        const listed = await scope.runWithin(exclusions, async () =>
            scope.outside(() => diff.getChangedFiles(root, BASE, 'HEAD')),
        );
        expect(listed.sort()).toEqual([LEGACY, GENERATED, HAND_WRITTEN].sort());
    });
});
