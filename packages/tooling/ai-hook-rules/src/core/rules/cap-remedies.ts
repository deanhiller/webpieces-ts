import {
    CacheFreshness,
    DeletableBranch,
    DeletableWorktree,
    MergedBranchesCache,
} from '@webpieces/rules-config';

import { FixHint, Option } from '../fix-hint';

/**
 * What branch-creation-guard says when a CAP is what blocked — and, just as importantly, what it does
 * NOT say.
 *
 * Split out of the guard itself because the guard's job is to decide, and this is a whole vocabulary
 * about cleanup that it kept getting wrong. On 2026-07-30 the worktree remedy printed a chained
 * `git worktree prune && git worktree remove … && git branch -D …` naming three worktrees with live
 * agents in them, under the words "so no work can be lost". Nothing in this class may emit a
 * destructive command; the one remedy is `pnpm wp-cleanup`, which archives, logs a recover command,
 * refuses its own tree, and ASKS about anything a merged PR has not proved dead.
 *
 * `freshness` is the age of the cache these hints are built from. A stale cache may be pointed AT but
 * never quoted FROM — see branchCap().
 */
export class CapRemedies {
    constructor(private readonly freshness: CacheFreshness | null) {}

    /**
     * The reap instructions. `deletable` is PRECOMPUTED in the cache, and every entry earned its place
     * by exactly ONE proof: a MERGED PR — its own, or the PR of the branch it is a squash snapshot of.
     * "Zero commits of its own" used to be a second proof and is not one any more; it is the normal
     * state of a branch somebody is working on right now (see CLASSIFICATION_NO_COMMITS), so it is
     * spared and merely PROMPTED about by wp-cleanup.
     *
     * The command is `pnpm wp-cleanup`, NOT the `git branch -D a b c` this used to emit. Two reasons,
     * both learned the hard way: agents read a bare `-D` as destructive and stop to ask (so nothing
     * was ever cleaned, and this cap kept firing), and the multi-name form aborts wholesale on the
     * first branch git refuses, stranding every branch after it in the list. wp-cleanup recomputes
     * the verdicts, deletes one branch per command, and logs each pre-delete SHA.
     *
     * The wording must not overstate the safety: the list is NOT uniformly "merged PR" branches, and
     * a message that tells an agent to delete has to be exactly true about why that's safe.
     */
    branchCap(cache: MergedBranchesCache): FixHint {
        const options: Option[] = [];
        // Nothing auto-reapable → the ASK is the preferred move, and it comes FIRST. This is the whole
        // point of the option: with an empty `deletable` list the only advice left used to be "raise
        // maxLocalBranches" / "set turnOffRuleUntilEpoch", and an agent with no human in the loop
        // edited webpieces.config.json to escape — loosening the very rule that was working correctly.
        // A stale cache may not be quoted as fact — same rule the violation message follows. Naming
        // branches out of it while the message above says "no count is asserted" would be the guard
        // contradicting itself, and the contradiction resolves in the direction of deleting things.
        const stale = this.freshness !== null && this.freshness.stale;
        const askFirst = cache.deletable.length === 0 || stale;

        if (stale) {
            options.push(new Option(
                'Run: pnpm wp-cleanup — the cached verdicts are stale, so it recomputes them from scratch, ' +
                'deletes only what a MERGED PR proves is dead, and asks you about the rest.',
                cache.keep.length === 0,
            ));
        } else if (cache.deletable.length > 0) {
            const names = cache.deletable.map((entry: DeletableBranch): string => entry.branch);
            options.push(new Option(
                `Run: pnpm wp-cleanup — it deletes these ${String(names.length)} dead branches. Every one is ` +
                'backed by a MERGED PR (its own, or the PR of the branch it snapshots) — that is now the ONLY ' +
                'proof that reaps anything unattended — and every delete is logged with a recover-by-SHA ' +
                `command (see merged-branches.json for the per-branch reason): ${names.join(' ')}`,
                true,
            ));
        }

        const ask = this.askHumanOption(cache, askFirst);
        if (ask) options.push(ask);

        options.push(new Option(
            'ONLY IF A HUMAN SAYS SO: raise branch-creation-guard.maxLocalBranches in ' +
            'webpieces.config.json. Editing this config to get past a guard is not a fix you may make on ' +
            'your own — ask first (use the option above).',
        ));
        options.push(new Option(
            'ONLY IF A HUMAN SAYS SO: set branch-creation-guard.turnOffRuleUntilEpoch (a future epoch) ' +
            'in webpieces.config.json to bypass this once. Same rule — ask, do not self-approve.',
        ));

        const kept = cache.keep.length > 0
            ? ` ${String(cache.keep.length)} branch(es) are NOT provably merged and were deliberately SPARED — ` +
              'treat them as LIVE; a human decides, never the tooling and never you.'
            : '';

        return new FixHint(
            'Too many local branches — reap the dead ones before creating another.',
            'Full detail (deletable + spared, with per-branch reasons) is in .webpieces/merged-branches.json, ' +
            `refreshed ${cache.timestamp || 'never'}.${kept} Pick one:`,
            options,
        );
    }

    /**
     * The remedy that actually deletes something without loosening anything: SHOW the spared branches
     * and ASK the human which may go.
     *
     * `keep` is the list the tooling refuses to touch on its own — no merged PR, so no proof the work
     * is safe. That is exactly the list a human can adjudicate in five seconds and the tooling never
     * can, and it was never printed: the cap said "N branches were SPARED, do not delete those" and
     * then offered only config edits. So the agent edited the config.
     *
     * Every column is read straight off `.webpieces/merged-branches.json` (written by the detached
     * refresher) — nothing is recomputed on this blocking path. The SHA is there so the human can see
     * the delete is reversible; the commit count is there so "0 commits" branches are obvious yeses.
     */
    private askHumanOption(cache: MergedBranchesCache, preferred: boolean): Option | null {
        if (cache.keep.length === 0) return null;

        const rows = cache.keep.map((entry: DeletableBranch): string => {
            const sha = entry.sha !== '' ? entry.sha : '???????';
            const pr = entry.pr > 0
                ? `PR #${String(entry.pr)} ${entry.prState || 'MERGED'}`
                : (entry.prState !== '' ? `PR ${entry.prState}` : 'no PR');
            const commits = entry.commits >= 0 ? `${String(entry.commits)} commit(s) of its own` : 'commit count unknown';
            return `    ${entry.branch}  [${sha}]  ${pr}  ${commits}  — ${entry.reason}`;
        });

        return new Option(
            `ASK THE HUMAN which of these ${String(cache.keep.length)} branches may be deleted. They are ` +
            'not provably dead, so the tooling will not reap them — but a human can decide in seconds, ' +
            'and deleting one is the correct fix for "too many branches". Paste this list and ask:\n' +
            rows.join('\n') + '\n' +
            'Then delete ONLY the ones approved: git branch -D <approved-branch>\n' +
            '(each is recoverable — `git branch <name> <sha>` restores it at the SHA shown above).\n' +
            'Do NOT delete any of these without an explicit yes, and do NOT edit webpieces.config.json instead.',
            preferred,
        );
    }

    /**
     * The worktree remedy — ONE command, `pnpm wp-cleanup`, and NOTHING that deletes anything itself.
     *
     * This guard used to print the equivalent git by hand: `git worktree prune && git worktree remove
     * <path> && ... && git branch -D <a> <b> <c>`, introduced as "so no work can be lost". On
     * 2026-07-30 that line named three worktrees with LIVE AGENTS in them, because "a branch with no
     * commits of its own" counted as dead — which is what every worktree looks like between
     * `git worktree add -b ... origin/main` and its first commit, i.e. exactly while it is being worked
     * in. That classification is fixed (see CLASSIFICATION_NO_COMMITS), and the one-liner is gone with
     * it, permanently, for two independent reasons:
     *
     *  - a single `&&` chain deleting seven things has no safe partial failure; and
     *  - this guard has no business owning reaping logic at all. wp-cleanup classifies from FRESH
     *    verdicts, archives every branch as an `archive/<date>/<branch>` tag before touching it, logs a
     *    `recover=` command per removal, refuses the primary clone and the tree it is standing in, never
     *    passes `--force`, and ASKS about anything not provably merged.
     *
     * So this method names WHAT is at the cap and hands over. It must never emit a destructive command.
     */
    worktreeCap(cache: MergedBranchesCache): FixHint {
        const options: Option[] = [];
        const dead = cache.worktrees.filter((tree: DeletableWorktree): boolean => tree.deletable);
        const stale = this.freshness !== null && this.freshness.stale;

        if (dead.length > 0 && !stale) {
            // Paths as a plain indented LIST — a description of what wp-cleanup will offer to remove,
            // never a command. Nothing in this block is copy-pasteable into a shell, on purpose.
            const paths = dead
                .map((tree: DeletableWorktree): string =>
                    `    ${tree.path}  [${tree.branch || 'detached'}]  - ${tree.reason}`)
                .join('\n');
            options.push(new Option(
                `Run: pnpm wp-cleanup — ${String(dead.length)} of these worktrees is/are backed by a MERGED ` +
                'PR or have a directory that is already gone, and it removes those (archiving each branch as ' +
                'a tag first, logging a `recover=` command for each). Everything else it ASKS about before ' +
                'touching. It will not remove the primary clone, the worktree you are standing in, or any ' +
                `worktree with uncommitted work:\n${paths}`,
                true,
            ));
        } else {
            options.push(new Option(
                'Run: pnpm wp-cleanup — it recomputes the verdicts from scratch, removes only what a MERGED ' +
                'PR proves is dead, and ASKS you about anything that merely looks dead (closed-unmerged PR, ' +
                'content already in main, never proposed, no commits yet) before removing anything. Answer ' +
                'that prompt instead of raising the cap.',
                true,
            ));
        }

        options.push(new Option(
            'ONLY IF A HUMAN SAYS SO: raise branch-creation-guard.maxWorktrees in webpieces.config.json. ' +
            'Editing this config to get past a guard is not a fix you may make on your own — ask first.',
        ));
        options.push(new Option(
            'ONLY IF A HUMAN SAYS SO: set branch-creation-guard.turnOffRuleUntilEpoch (a future epoch) ' +
            'in webpieces.config.json to bypass this once. Same rule — ask, do not self-approve.',
        ));

        return new FixHint(
            'Too many worktrees — run pnpm wp-cleanup before creating another. Do NOT remove any worktree ' +
            'by hand: a worktree whose branch has no commits yet is almost always one an agent is working ' +
            'in RIGHT NOW, and nothing here is proof that it is dead.',
            'Full detail (with per-worktree reasons) is in .webpieces/merged-branches.json, ' +
            `refreshed ${cache.timestamp || 'never'}.${this.sparedNote(cache)} Pick one:`,
            options,
        );
    }

    /**
     * What was SPARED, and the standing instruction about it: leave it alone.
     *
     * Worded as "not provably merged", never as "probably dead". A spared worktree is LIVE until a
     * merged PR says otherwise, and the previous wording ("holding unmerged work") quietly implied that
     * everything NOT on that list was safe to remove.
     */
    private sparedNote(cache: MergedBranchesCache): string {
        const spared = cache.worktrees.filter((tree: DeletableWorktree): boolean => !tree.deletable).length;
        if (spared === 0) return '';
        return ` ${String(spared)} worktree(s) are NOT provably merged — treat every one of them as LIVE ` +
            '(an agent may be working in it right now) and never remove one without an explicit human yes.';
    }
}
