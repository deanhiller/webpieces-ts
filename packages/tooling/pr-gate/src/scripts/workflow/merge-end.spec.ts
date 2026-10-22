import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { MergeEnd, MergeEndOptions } from './merge-end';
import { MergeContext } from './merge-start';

/**
 * Finalizing a 3-point merge, from the shipped container with git SCRIPTED (#1381). Every git command
 * finalize issues is recorded, so the invariant — WHETHER a push was attempted, and whether the pre-merge
 * snapshot survives — is asserted on the commands themselves.
 */

let repoRoot = '';
let feature: PrGateFeature;

beforeEach(async (): Promise<void> => {
    repoRoot = specTempDirs.make('wp-merge-end-');
    feature = await PrGateFeature.create();
});

afterEach((): void => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
});

const ctx = (): MergeContext => new MergeContext('dean/feat', 'dean/featSquash', 'dean/featPreMerge1', '7');

/** Git: every command succeeds; the remote branch exists; the snapshot branch exists iff `backupExists`. */
const finalize = async (pushRemote: boolean, backupExists: boolean = true): Promise<string[]> => {
    const git = feature.git;
    git.respond(['show-ref', '--verify', '--quiet', 'refs/heads/dean/featPreMerge1'], backupExists ? git.ok() : git.fail(1));
    git.respond(['ls-remote', '--exit-code', '--heads', 'origin', 'dean/feat'], git.ok('abc\trefs/heads/dean/feat\n'));
    git.respondToPrefix([], git.ok());
    // conflictedFiles null => clean merge, finalize only (no validation path, no marker on disk).
    await feature.container.get(MergeEnd)
        .mergeEnd(repoRoot, 'wp-start-upsert-pr', repoRoot, ctx(), new MergeEndOptions(null, pushRemote));
    // Every git command flattened (without the `git`), for asserting what was and was NOT run.
    return git.calls.map((c): string => c.args.join(' '));
};

const pushes = (commands: string[]): string[] => commands.filter((c: string): boolean => c.startsWith('push'));

describe('pushRemote=false — the PR flow, where wp-finish-upsert-pr owns the single push', () => {
    it('does not push', async (): Promise<void> => {
        const commands = await finalize(false);
        expect(pushes(commands)).toEqual([]);
        // …and does not even ask whether the remote branch exists.
        expect(commands.some((c: string): boolean => c.startsWith('ls-remote'))).toBe(false);
    });

    it('KEEPS the pre-merge snapshot — an unpushed squash rewrite must exist somewhere other than HEAD', async (): Promise<void> => {
        const commands = await finalize(false);
        expect(commands).not.toContain('branch -D dean/featPreMerge1');
    });

    it('still finalizes the branch swap (delete old, checkout squash, rename to the feature name)', async (): Promise<void> => {
        const commands = await finalize(false);
        expect(commands).toContain('branch -D dean/feat');
        expect(commands).toContain('checkout dean/featSquash');
        expect(commands).toContain('branch -m dean/feat');
    });
});

describe('pushRemote=true — the update-only flow, where finalizing IS the end', () => {
    it('pushes', async (): Promise<void> => {
        const commands = await finalize(true);
        expect(pushes(commands)).toEqual(['push -u --force-with-lease origin dean/featSquash:dean/feat']);
    });

    it('deletes the pre-merge snapshot on a clean merge — origin now has the result, so it is disposable', async (): Promise<void> => {
        const commands = await finalize(true);
        expect(commands).toContain('branch -D dean/featPreMerge1');
    });

    it('does not try to delete a snapshot that is not there', async (): Promise<void> => {
        const commands = await finalize(true, false);
        expect(commands).not.toContain('branch -D dean/featPreMerge1');
    });
});
