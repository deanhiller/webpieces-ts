import { gitCheckout } from '@webpieces/tooling-common';
import { BranchIdentity } from '@webpieces/repo-workflow-core';

/**
 * Is the checkout rooted at `treeRoot` on a `/hotfix/` branch?
 *
 * The convention itself is BranchIdentity's — the ONE exact, case-sensitive `/hotfix/` predicate every
 * webpieces surface shares — asked of the branch GitCheckout reads off that tree's own HEAD, so the
 * answer costs no git process on the hook path. It lives here, beside `shouldSkipRule`, because the
 * edit-time code rules (`wp-ai-rules-hook`) may not depend on repo-workflow-core directly
 * (scripts/hook-boundaries.cjs) and still need the question answered (issue #1371): a hotfix's gate is
 * `hotfix-ci` — compile and tests only — so the same lint, run earlier, stands down there too.
 */
export class HotfixCheckout {
    private readonly branches = new BranchIdentity();

    isHotfix(treeRoot: string): boolean {
        const branch = gitCheckout.branch(treeRoot);
        return branch !== null && this.branches.isHotfix(branch);
    }
}
