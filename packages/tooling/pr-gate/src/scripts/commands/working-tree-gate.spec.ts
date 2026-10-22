import { describe, it, expect, beforeEach } from 'vitest';
import { CliExitError } from '@webpieces/rules-config';

import { PrGateFeature } from '../../__tests__/feature-harness';
import { WorkingTreeGate, UntrackedFiles } from './working-tree-gate';

/**
 * Feature tests for `wp-sync-main`'s clean-tree gate (#1381), against a SCRIPTED git. The decision the
 * gate makes is pinned by the exact questions it asks git: the TRACKED-only status
 * (`--untracked-files=no`, so no `??` line is ever parsed to decide) and the NUL-separated untracked list
 * (`ls-files -z`, so a path is never quoted or split). The answers below are what git prints for each
 * working-tree state.
 */

const REPO = '/repo';
const TRACKED = ['-C', REPO, 'status', '--porcelain', '--untracked-files=no'];
const UNTRACKED = ['-C', REPO, 'ls-files', '--others', '--exclude-standard', '-z'];

let feature: PrGateFeature;

function gateCall(): Promise<UntrackedFiles> {
    return feature.container.get(WorkingTreeGate).assertNoTrackedChanges(REPO);
}

/** What git answers: the tracked-only porcelain, and the untracked paths NUL-joined. */
function treeIs(trackedPorcelain: string, untracked: string[]): void {
    feature.git.respond(TRACKED, feature.git.ok(trackedPorcelain));
    feature.git.respond(UNTRACKED, feature.git.ok(untracked.map((p: string): string => `${p}\0`).join('')));
}

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
});

describe('WorkingTreeGate', (): void => {
    it('a fully clean tree passes and reports no untracked files', async (): Promise<void> => {
        treeIs('', []);
        const untracked = await gateCall();
        expect(untracked.isEmpty()).toBe(true);
        expect(untracked.render()).toBe('');
    });

    it('UNTRACKED files ONLY: proceeds, and hands the paths back to be mentioned', async (): Promise<void> => {
        treeIs('', ['generated/design.html']);
        const untracked = await gateCall();
        expect(untracked.paths).toEqual(['generated/design.html']);
        expect(untracked.render()).toContain('generated/design.html');
        expect(untracked.render()).toContain('leaves them exactly where');
    });

    it('an untracked path containing a SPACE comes back whole, not quoted or split', async (): Promise<void> => {
        treeIs('', ['some dir/a file.html']);
        const untracked = await gateCall();
        expect(untracked.paths).toEqual(['some dir/a file.html']);
        expect(untracked.render()).toContain('  some dir/a file.html\n');
    });

    it('a MODIFIED tracked file refuses', async (): Promise<void> => {
        treeIs(' M tracked.txt\n', []);
        await expect(gateCall()).rejects.toBeInstanceOf(CliExitError);
    });

    it('a STAGED change refuses too — index changes ride along just as working-tree ones do', async (): Promise<void> => {
        treeIs('A  staged.txt\n', []);
        await expect(gateCall()).rejects.toBeInstanceOf(CliExitError);
    });

    it('BOTH tracked and untracked: still refuses, and names only the tracked one', async (): Promise<void> => {
        treeIs(' M tracked.txt\n', ['generated/design.html']);
        const call = gateCall();
        await expect(call).rejects.toThrowError(/tracked\.txt/);
        // The untracked file is not the reason for the refusal, so listing it would send the reader
        // chasing a file that has nothing to do with it.
        await expect(call).rejects.not.toThrowError(/design\.html/);
    });

    /**
     * The printed cure must resolve the state it is printed for. A plain `git stash` takes exactly the
     * TRACKED changes this gate refuses on, so once it has run git reports a clean tracked status and the
     * second call passes.
     */
    it('the refusal prescribes `git stash`, and once the tracked change is stashed the gate passes', async (): Promise<void> => {
        feature.git.respond(TRACKED, feature.git.ok(' M tracked.txt\n'));
        feature.git.respond(TRACKED, feature.git.ok(''));
        feature.git.respond(UNTRACKED, feature.git.ok(''));

        await expect(gateCall()).rejects.toThrowError(/git stash/);
        expect((await gateCall()).isEmpty()).toBe(true);
    });

    it('a tracked file whose PATH contains a space is still seen as tracked-dirty', async (): Promise<void> => {
        treeIs(' M "a tracked file.txt"\n', []);
        await expect(gateCall()).rejects.toBeInstanceOf(CliExitError);
    });

    it('an IGNORED file is not untracked work — the gate asks git to exclude .gitignore matches', async (): Promise<void> => {
        treeIs('', []);
        expect((await gateCall()).isEmpty()).toBe(true);
        expect(feature.git.callsStartingWith(UNTRACKED)).toHaveLength(1);
    });

    it('a git that cannot answer is treated as nothing to report, never as a refusal', async (): Promise<void> => {
        feature.git.respond(TRACKED, feature.git.fail(128, 'fatal: not a git repository'));
        feature.git.respond(UNTRACKED, feature.git.fail(128, 'fatal: not a git repository'));
        expect((await gateCall()).isEmpty()).toBe(true);
    });
});
