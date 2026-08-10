import * as path from 'path';

import { EffectiveTree, EffectiveTreeResolver } from './effective-tree';
import { BlockedResult } from './types';

/**
 * L1 row 5: git/gh commands must run from the repo root of the tree they act on, where the guards can
 * reason about git state coherently. guards/L1-location.md carries the table and the use cases; change
 * this predicate and that file is stale until you update it.
 *
 * ONE variable decides it: `tree.effectiveCwd` — the directory the command actually runs in, which is
 * the shell's cwd unless the command leads with `cd <dir> &&`. Root or not-root, nothing else.
 *
 * It used to be `shellAtRoot || cdsToRoot`, two variables OR'd, and that produced opposite verdicts for
 * the same destination: `git status` with the shell in packages/http/ was BLOCKED, while
 * `cd packages/http && git status` from the root was ALLOWED, because shellAtRoot short-circuited before
 * the destination was ever considered. An agent that cd's INTO a subdir has the same broken mental model
 * as one stranded there, so it gets the same answer now.
 *
 * The remedy is ONE runnable line, `cd <root> && <the work>`, not "cd first, then re-run" — that advice
 * made this guard print the very command it had just rejected, and a `cd` is unreliable in both
 * directions (INTO this repo it sticks; OUT of it the harness resets it).
 *
 * It goes through remedyAtRoot(), NOT bare atRoot(), and that is load-bearing: A REMEDY MUST SATISFY THE
 * PREDICATE THAT PRINTED IT. Prefixing `cd '<root>' &&` onto a command already leading with
 * `cd <elsewhere> &&` left effectiveCwd in `<elsewhere>`, so the identical block fired on the remedy with
 * the prefix doubled, then tripled. remedyAtRoot REPLACES the leading `cd` run instead, and
 * effective-tree.spec.ts asserts that property for every L1 remedy, not just this one.
 */
export class ForceToRootGuard {
    private readonly resolver = new EffectiveTreeResolver();

    /** The deny report, or null to allow. */
    block(command: string, tree: EffectiveTree, isGitOrGh: boolean): string | null {
        const targetAtRoot = path.resolve(tree.effectiveCwd) === path.resolve(tree.root);
        if (!isGitOrGh || targetAtRoot) return null;
        return [
            '❌ Run git/gh commands from the repo root, not a subdirectory.',
            `   Command runs in: ${tree.effectiveCwd}`,
            `   Judged against: ${tree.root}`,
            '   Run EXACTLY this instead, as ONE line (a bare `cd` in a separate call is not equivalent —',
            '   a `cd` inside this repo STICKS for later calls, and a `cd` out of it is reset by the harness):',
            `     ${this.resolver.remedyAtRoot(tree.root, command)}`,
            '   A leading `cd <path> &&` is ACCEPTED by the guards — it cannot change what the command',
            "   does to the repo. (The webpieces guards evaluate the repo's git state at its root.)",
        ].join('\n');
    }
}

// L1 row 5's dispatch entry, beside the guard it wraps — see missing-directory.ts for why these live
// with their guard rather than in runner.ts.
// webpieces-disable no-function-outside-class -- the one-line runner entry point for the class above, beside it
export function gitFromSubdirBlock(command: string, tree: EffectiveTree, isGitOrGh: boolean): BlockedResult | null {
    const report = new ForceToRootGuard().block(command, tree, isGitOrGh);
    return report === null ? null : new BlockedResult(report);
}
