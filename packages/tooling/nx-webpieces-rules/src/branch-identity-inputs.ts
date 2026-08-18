import { TargetConfiguration } from '@nx/devkit';

/**
 * The BRANCH IDENTITY, as nx task-hash inputs. Append these to any CACHED target that can be turned off by
 * `turnOffRuleWhileOnBranch`.
 *
 * WHY A CACHED RULE TARGET NEEDS THEM: the branch hatch makes a rule's verdict depend on which branch you
 * are on, and nothing about the branch is otherwise in the hash. So a hatched branch runs `<project>:ci`
 * green and caches it under hash H; a later, UNRELATED PR that did not touch that project's files hashes to
 * the same H and REPLAYS the hatched green — the relaxation escapes the one branch that opted into it,
 * which is the single property the hatch is supposed to guarantee.
 *
 * `{workspaceRoot}/webpieces.config.json` in `sharedGlobals` (nx.json) is the other half and neither half
 * is sufficient alone: the config file makes EDITING a hatch bust the cache, but two branches sharing one
 * unedited config file still hash identically — which is exactly the leak above.
 *
 * DELIBERATELY NOT IN `sharedGlobals`. Putting a branch-varying value there would make EVERY task hash
 * branch-unique and destroy cross-branch cache reuse fleet-wide (CLAUDE.md's measured ~3.2x contention cost
 * is what that buys you). Scoped to the rule-running targets, `build`/`test`/`lint` keep sharing.
 *
 * The two vars are the same pair `getCurrentBranch()` reads, in the same order, so the hash keys off
 * exactly the values the skip decision keys off. A plain `git rev-parse` is deliberately NOT used: nx
 * inputs must be cheap and pure, and on the CI checkout the vars are the authoritative answer anyway.
 *
 * These are object literals because that is the nx INPUT DSL, not a webpieces data structure — the same
 * form the `{'runtime': ...}` inputs in validation-targets.ts already use.
 */
export const BRANCH_IDENTITY_INPUTS: NonNullable<TargetConfiguration['inputs']> = [
    { env: 'GITHUB_HEAD_REF' },
    { env: 'WEBPIECES_BRANCH' },
];
