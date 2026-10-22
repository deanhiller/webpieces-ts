import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The four-row table from the bug report, one test each: given the PR's `(headRefName, headRefOid)`,
 * WHICH local tree — if any — may be archived from and reaped?
 *
 * Only git is faked, and only two of its questions matter: `worktree list --porcelain` (every
 * `(path, branch, HEAD sha)` in the repo, readable from any tree because the list lives in the common
 * dir) and `rev-parse <branch>` (the branch ref when no worktree holds it). Nothing here reads state,
 * which is the point — see the class doc on why a `.webpieces/**` receipt was rejected.
 *
 * Both are SCRIPTED on the injected GitProcessApi (#1381) — the worktree list is asked by
 * `@webpieces/repo-workflow-core`'s WorktreeService through that same edge — so no process is started.
 */
const world = vi.hoisted(() => ({
    porcelain: '',
    refs: {} as Record<string, string>,
}));

import { GitResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';
import { PrGateFeature } from '../../__tests__/feature-harness';

import {
    LandedTreeResolver,
    LANDED_TREE_ABSENT,
    LANDED_TREE_BRANCH_ONLY,
    LANDED_TREE_WORKTREE,
    LANDED_TREE_WRONG_TIP,
} from './landed-tree-resolver';

const PRIMARY = '/repo';
const AGENT = '/repo/.claude/worktrees/agent-x';
const BRANCH = 'dean/feature';
const LANDED_SHA = 'bbbbbbb';

let feature: PrGateFeature;

function resolver(): LandedTreeResolver {
    return feature.container.get(LandedTreeResolver);
}

// Primary clone on main, plus one nested agent worktree holding the branch at `head`.
function withAgentWorktree(head: string): void {
    world.porcelain = `worktree ${PRIMARY}\nHEAD aaaaaaa\nbranch refs/heads/main\n\n`
        + `worktree ${AGENT}\nHEAD ${head}\nbranch refs/heads/${BRANCH}\n`;
}

beforeEach(async () => {
    world.porcelain = `worktree ${PRIMARY}\nHEAD aaaaaaa\nbranch refs/heads/main\n`;
    world.refs = {};
    feature = await PrGateFeature.create();
    feature.git.respond(['worktree', 'list', '--porcelain'], (): GitResultDto => new GitResultDto(0, world.porcelain, ''));
    // `git rev-parse <ref>` answers from world.refs: the sha, or git's 128 for a ref this repo lacks.
    feature.git.respondToPrefix(['rev-parse'], (call: ProcessCallDto): GitResultDto => {
        const sha = world.refs[String(call.args[1])];
        return sha === undefined
            ? new GitResultDto(128, '', `fatal: ambiguous argument '${String(call.args[1])}'`)
            : new GitResultDto(0, `${sha}\n`, '');
    });
});

describe('LandedTreeResolver — which tree holds the commit GitHub squashed', () => {
    // Row 1. The reap target is the tree whose HEAD IS the landed commit — found by the pair, and found
    // identically from the primary clone, from that worktree, or from any other.
    it('selects the worktree holding the branch AT the landed sha', async () => {
        withAgentWorktree(LANDED_SHA);

        const tree = (await resolver().resolve(PRIMARY, BRANCH, LANDED_SHA));

        expect(tree.kind).toBe(LANDED_TREE_WORKTREE);
        expect(tree.bookkeepingAllowed).toBe(true);
        expect(tree.worktree?.path).toBe(AGENT);
    });

    /**
     * Row 2, and the reason a NAME is never enough. Somebody committed in that worktree after finish
     * ran, so it holds work the archive tag of the squashed tip does not contain. Archiving from there
     * would tag the wrong objects under the right name.
     */
    it('declines when a worktree holds the branch at a DIFFERENT sha, and reports what it found', async () => {
        withAgentWorktree('ccccccc');

        const tree = (await resolver().resolve(PRIMARY, BRANCH, LANDED_SHA));

        expect(tree.kind).toBe(LANDED_TREE_WRONG_TIP);
        expect(tree.bookkeepingAllowed).toBe(false);
        expect(tree.worktree).toBeNull();
        expect(tree.localSha).toBe('ccccccc');
    });

    // Row 3. No worktree, but this clone's branch ref IS the landed commit: archive it, with no
    // directory to reap.
    it('allows the bookkeeping when only the branch ref holds the landed commit', async () => {
        world.refs = { [BRANCH]: LANDED_SHA };

        const tree = (await resolver().resolve(PRIMARY, BRANCH, LANDED_SHA));

        expect(tree.kind).toBe(LANDED_TREE_BRANCH_ONLY);
        expect(tree.bookkeepingAllowed).toBe(true);
        expect(tree.worktree).toBeNull();
    });

    // Row 4. Landed from a tree that does not hold it at all — a fresh clone, or a coordinator who
    // never fetched the branch. The merge stands; nothing local may be archived or removed.
    it('declines when the branch is not in this repo at all', async () => {
        const tree = (await resolver().resolve(PRIMARY, BRANCH, LANDED_SHA));

        expect(tree.kind).toBe(LANDED_TREE_ABSENT);
        expect(tree.bookkeepingAllowed).toBe(false);
        expect(tree.localSha).toBe('');
    });

    // A second clone's branch of the same NAME is a different commit — the wrong-objects case, reached
    // through the ref rather than through a worktree.
    it('declines when the branch ref is a different commit', async () => {
        world.refs = { [BRANCH]: 'ddddddd' };

        expect((await resolver().resolve(PRIMARY, BRANCH, LANDED_SHA)).kind).toBe(LANDED_TREE_WRONG_TIP);
    });

    /**
     * The PRIMARY clone is never a reap target — it is the directory reaped FROM. When it is what holds
     * the branch, the bookkeeping still runs (its refs are the landed objects), but there is no
     * worktree to hand to the child.
     */
    it('never offers the primary clone as a worktree to reap', async () => {
        world.porcelain = `worktree ${PRIMARY}\nHEAD ${LANDED_SHA}\nbranch refs/heads/${BRANCH}\n`;
        world.refs = { [BRANCH]: LANDED_SHA };

        const tree = (await resolver().resolve(PRIMARY, BRANCH, LANDED_SHA));

        expect(tree.kind).toBe(LANDED_TREE_BRANCH_ONLY);
        expect(tree.worktree).toBeNull();
    });

    /**
     * `gh` told us nothing about the head commit. A fact we do not have is not evidence of disagreement,
     * so the local tip is taken as the landed one — exactly what the previous `headRefOid !== ''` guard
     * did, kept so a `gh` that stops emitting the field degrades to the old behaviour rather than
     * silently declining every bookkeeping run.
     */
    it('does not turn an unknown head sha into a mismatch', async () => {
        withAgentWorktree('ccccccc');

        expect((await resolver().resolve(PRIMARY, BRANCH, '')).kind).toBe(LANDED_TREE_WORKTREE);
    });
});
