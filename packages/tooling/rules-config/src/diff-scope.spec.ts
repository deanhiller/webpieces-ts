import { describe, it, expect, beforeEach } from 'vitest';
import { GitResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';

import { RulesConfigFeature } from './__tests__/rules-config-feature';
import { ChangedFilesOptions, DiffScope } from './diff-scope';

const BASE = 'base-sha';
const HEAD = 'head-sha';

/** One path git reports changed: A(dded), M(odified) or D(eleted). A rename is its D + its A. Data only. */
class Change {
    constructor(readonly status: string, readonly path: string) {}
}

/**
 * What git knows about this repo (#1381): the changes between BASE and HEAD (committed), between BASE and
 * the working tree, and the untracked files. `git diff --name-only` is answered from it exactly as git
 * answers — `--diff-filter=d` drops the deletions, a two-ref diff reads the committed changes, a one-ref
 * diff the working tree — so each scenario holds what DiffScope ASKED git and what it did with the answer.
 */
class ChangeWorld {
    committed: Change[] = [];
    working: Change[] = [];
    untracked: string[] = [];

    answer(call: ProcessCallDto): GitResultDto {
        const args = call.args;
        if (args[0] === 'ls-files') return new GitResultDto(0, this.untracked.join('\n') + '\n', '');
        if (args[0] !== 'diff') return new GitResultDto(1, '', `unscripted git ${args.join(' ')}`);
        const refs = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
            .filter((arg: string): boolean => arg === BASE || arg === HEAD);
        const changes = refs.length === 2 ? this.committed : this.working;
        const dropDeletions = args.includes('--diff-filter=d');
        const names = changes
            .filter((change: Change): boolean => !dropDeletions || change.status !== 'D')
            .map((change: Change): string => change.path);
        return new GitResultDto(0, names.join('\n') + '\n', '');
    }
}

// The reorg every ghost-path scenario starts from: Moved.ts `git mv`ed under nested/, Deleted.ts removed.
function reorg(): Change[] {
    return [
        new Change('D', 'libraries/foo/src/Moved.ts'),
        new Change('A', 'libraries/nested/foo/src/Moved.ts'),
        new Change('D', 'libraries/foo/src/Deleted.ts'),
    ];
}

let world: ChangeWorld;
let feature: RulesConfigFeature;
let diffScope: DiffScope;

beforeEach(async () => {
    world = new ChangeWorld();
    feature = await RulesConfigFeature.create();
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => world.answer(call));
    diffScope = feature.container.get(DiffScope);
});

/**
 * Reproduces BUG-validate-ts-in-src-false-positive: `git diff --name-only` lists the OLD side of
 * deletes and renames, so diff-scoped rules were validating paths that no longer exist (e.g.
 * flagging `libraries/apis/src/.../AuthApi.ts` as "outside any Nx project" after the whole
 * directory was `git mv`ed elsewhere). getChangedFiles must never return a path that is absent
 * from the working tree.
 */
describe('getChangedFiles ghost paths (deleted/renamed old paths)', () => {
    it('excludes deleted files and reports renames only at their new path', async () => {
        world.working = reorg();

        const changed = await diffScope.getChangedFiles('/repo', BASE);

        expect(changed).toContain('libraries/nested/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Deleted.ts');
        expect(feature.git.commandLines()).toEqual([
            `git diff --name-only --diff-filter=d ${BASE} -- *.ts *.tsx`,
            'git ls-files --others --exclude-standard -- *.ts *.tsx',
        ]);
    });

    it('excludes an uncommitted working-tree deletion', async () => {
        world.working = [new Change('D', 'libraries/foo/src/Deleted.ts')];

        const changed = await diffScope.getChangedFiles('/repo', BASE);

        expect(changed).not.toContain('libraries/foo/src/Deleted.ts');
    });

    it('still reports modified and untracked files', async () => {
        world.working = [new Change('M', 'libraries/foo/src/Keep.ts')];
        world.untracked = ['libraries/foo/src/Untracked.ts'];

        const changed = await diffScope.getChangedFiles('/repo', BASE);

        expect(changed).toContain('libraries/foo/src/Keep.ts');
        expect(changed).toContain('libraries/foo/src/Untracked.ts');
    });

    it('excludes deletions in a two-ref (base..head) diff', async () => {
        world.committed = reorg();

        const changed = await diffScope.getChangedFiles('/repo', BASE, HEAD);

        expect(changed).toContain('libraries/nested/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Deleted.ts');
        // A two-ref diff is a statement about commits: the working tree's untracked files are not asked for.
        expect(feature.git.commandLines()).toEqual([`git diff --name-only --diff-filter=d ${BASE} ${HEAD} -- *.ts *.tsx`]);
    });

});

// Split out to keep each describe under the method-length limit.
describe('getChangedFiles — deletions are opt-in', () => {
    /**
     * Deletions are excluded BY DEFAULT — right for a lint validator (you cannot lint a file that is gone),
     * and wrong for checklist matching. A PR that DELETES a migration, an auth check or a terraform rule
     * changed exactly the thing a checklist exists to catch, and under the default the file is invisible,
     * so no checklist fires and no reviewer is ever asked. `includeDeletions` is how the review flow opts in.
     */
    it('includeDeletions:true surfaces a deleted file that the default hides', async () => {
        world.committed = [new Change('D', 'libraries/foo/src/Deleted.ts')];
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;

        expect(await diffScope.getChangedFiles('/repo', BASE, HEAD, opts)).not.toContain('libraries/foo/src/Deleted.ts');

        opts.includeDeletions = true;
        expect(await diffScope.getChangedFiles('/repo', BASE, HEAD, opts)).toContain('libraries/foo/src/Deleted.ts');
        expect(feature.git.commandLines()).toEqual([
            `git diff --name-only --diff-filter=d ${BASE} ${HEAD}`,
            `git diff --name-only ${BASE} ${HEAD}`,
        ]);
    });

    // The default must stay byte-identical, so every existing lint-validator caller is unaffected.
    it('leaves the default untouched when includeDeletions is omitted or false', async () => {
        world.committed = [new Change('D', 'libraries/foo/src/Deleted.ts'), new Change('M', 'libraries/foo/src/Keep.ts')];
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        opts.includeDeletions = false;
        const omitted = new ChangedFilesOptions();
        omitted.tsOnly = false;

        expect(await diffScope.getChangedFiles('/repo', BASE, HEAD, opts))
            .toEqual(await diffScope.getChangedFiles('/repo', BASE, HEAD, omitted));
        expect(feature.git.commandLines()[0]).toBe(feature.git.commandLines()[1]);
    });
});
