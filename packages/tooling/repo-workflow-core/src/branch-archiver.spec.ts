import { describe, it, expect, beforeEach } from 'vitest';
import { GitResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';

import { WorkflowFeature } from './__tests__/workflow-feature';
import { ARCHIVE_TAG_PREFIX, BranchArchiver } from './branch-archiver';

/**
 * The archiver's DECISIONS — the tag name, never overwriting, idempotence, reporting a failure — against
 * scripted git (#1381). git's own behaviour (a tag keeps the objects exactly; a tag is not a branch) is
 * proven against the installed git by `branch-archiver.real-git.spec.ts`.
 *
 * {@link RefStore} answers the four commands the archiver issues exactly as git does, from the branches
 * and tags it holds; each scenario also asserts the `git tag` commands the program issued.
 */
class RefStore {
    readonly branches = new Map<string, string>();
    readonly tags = new Map<string, string>();

    answer(call: ProcessCallDto): GitResultDto {
        const args = call.args;
        if (args[0] === 'tag' && args[1] === '--list') {
            const names = [...this.tags.keys()].filter((tag: string): boolean => tag.startsWith(`${ARCHIVE_TAG_PREFIX}/`));
            return new GitResultDto(0, names.join('\n') + '\n', '');
        }
        if (args[0] === 'tag') {
            if (this.tags.has(args[1])) return new GitResultDto(128, '', `fatal: tag '${args[1]}' already exists`);
            this.tags.set(args[1], args[2]);
            return new GitResultDto(0, '', '');
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
            return new GitResultDto(this.tags.has(args[3].replace('refs/tags/', '')) ? 0 : 1, '', '');
        }
        if (args[0] === 'rev-parse' && args[1].startsWith('refs/tags/')) {
            const sha = this.tags.get(args[1].replace('refs/tags/', '').replace('^{commit}', ''));
            return sha === undefined ? new GitResultDto(128, '', 'unknown revision') : new GitResultDto(0, `${sha}\n`, '');
        }
        if (args[0] === 'rev-parse') {
            const sha = this.branches.get(args[1]);
            return sha === undefined
                ? new GitResultDto(128, '', `fatal: ambiguous argument '${args[1]}': unknown revision`)
                : new GitResultDto(0, `${sha}\n`, '');
        }
        return new GitResultDto(1, '', `unscripted git ${args.join(' ')}`);
    }
}

let refs: RefStore;
let feature: WorkflowFeature;
let archiver: BranchArchiver;
const repo = '/repo';

// The `git tag <name> <sha>` commands the archiver issued — the refs it CREATED.
function tagsCreated(): string[] {
    return feature.git.commandLines().filter((line: string): boolean => line.startsWith('git tag ') && !line.startsWith('git tag --list'));
}

beforeEach(async () => {
    refs = new RefStore();
    feature = await WorkflowFeature.create();
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => refs.answer(call));
    archiver = feature.container.get(BranchArchiver);
});

describe('archive tag naming and collision safety', () => {
    it('names the tag archive/<YYYY-MM-DD>/<branch>, under the one archive namespace', async () => {
        refs.branches.set('dean/foo', 'aaa111');

        const result = await archiver.archive(repo, 'dean/foo', new Date(2026, 6, 30));

        expect(result.tag).toBe(`${ARCHIVE_TAG_PREFIX}/2026-07-30/dean/foo`);
        expect(await archiver.listArchiveTags(repo)).toEqual([`${ARCHIVE_TAG_PREFIX}/2026-07-30/dean/foo`]);
        expect(tagsCreated()).toEqual([`git tag ${ARCHIVE_TAG_PREFIX}/2026-07-30/dean/foo aaa111`]);
    });

    /**
     * Archiving the same branch name twice on the same day must not destroy the first archive. `git tag
     * -f` would silently overwrite it — which is precisely the data loss the archive exists to prevent —
     * so the second gets a `-2` suffix and BOTH remain restorable.
     */
    it('never overwrites an existing archive: the second same-day archive gets a -2 suffix', async () => {
        refs.branches.set('dean/foo', 'aaa111');
        const when = new Date(2026, 6, 30);
        const first = await archiver.archive(repo, 'dean/foo', when);
        const firstSha = first.sha;

        refs.branches.set('dean/foo', 'bbb222');
        const second = await archiver.archive(repo, 'dean/foo', when);

        expect(second.tag).toBe(`${ARCHIVE_TAG_PREFIX}/2026-07-30/dean/foo-2`);
        expect(second.sha).not.toBe(firstSha);
        // Both tips are still addressable — nothing was clobbered, and nothing was ever forced.
        expect(refs.tags.get(first.tag)).toBe(firstSha);
        expect(refs.tags.get(second.tag)).toBe(second.sha);
        expect(tagsCreated().some((line: string): boolean => line.includes(' -f'))).toBe(false);
    });

    // Failure has to be reported, not thrown: the caller's correct response is "then do not delete
    // either", which it can only choose if it gets an answer back.
    it('reports a failure rather than throwing when the branch does not exist', async () => {
        const result = await archiver.archive(repo, 'no/such/branch');

        expect(result.ok).toBe(false);
        expect(result.tag).toBe('');
        expect(result.error).toContain('cannot resolve');
        expect(tagsCreated()).toEqual([]);
    });
});

describe('archiving is idempotent for an unchanged tip', () => {
    /**
     * The SAME tip archived twice is not a collision — it is the same archive, and minting a `-2`
     * beside it invents a second snapshot that never existed.
     *
     * This is exactly the shape `wp-land-pr` produces: it tags the landed branch for its own recap,
     * then hands the worktree reap to a child process which (correctly — it trusts nothing the parent
     * told it) archives again a second later. Two identical refs would be one more thing for anyone
     * reading `git tag --list 'archive/*'` to explain away.
     */
    it('reuses the existing tag when the same tip is archived twice', async () => {
        refs.branches.set('dean/foo', 'aaa111');
        const when = new Date(2026, 6, 30);

        const first = await archiver.archive(repo, 'dean/foo', when);
        const second = await archiver.archive(repo, 'dean/foo', when);

        expect(second.ok).toBe(true);
        expect(second.tag).toBe(first.tag);
        expect(second.sha).toBe(first.sha);
        expect(await archiver.listArchiveTags(repo)).toEqual([first.tag]);
        expect(tagsCreated()).toHaveLength(1);
    });
});
