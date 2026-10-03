import { BaseRuleConfig } from '@webpieces/rules-sdk';
import { WebpiecesRulesConfig } from "@webpieces/rules-config";
import { BranchCreationGuardConfig, PrLifecycleGuardConfig } from "../configs/rule-configs";
import { BranchStateGuardConfig } from "../configs/main-sync-guard-configs";
import { Rule, EmptyRuleConfig } from '@webpieces/hook-runtime';
import { BranchCreationGuardRule } from './rules/branch-creation-guard';
import { PrCreationOrPushGuardRule } from './rules/pr-creation-or-push-guard';
import { MergeInProgressGuardRule } from './rules/merge-in-progress-guard';
import { BuildOutputPipeGuardRule } from './rules/build-output-pipe-guard';
import { WaitSpinGuardRule } from './rules/wait-spin-guard';
import { PrMergeGuardRule } from './rules/pr-merge-guard';
import { RedirectHowToMergeMainRule } from './rules/redirect-how-to-merge-main';
import { FeatureBranchGuardRule } from './rules/feature-branch-guard';
import { ReadStaleGuardRule } from './rules/read-stale-guard';
import { MergedBranchBashGuardRule } from './rules/merged-branch-bash-guard';
import { StaleMainBashGuardRule } from './rules/stale-main-bash-guard';
import { WholeRepoBuildGuardRule } from './rules/whole-repo-build-guard';
import { CommitMessageSubstitutionGuardRule } from './rules/commit-message-substitution-guard';

export class GuardHintCommands {
    constructor(readonly upsertPr: string, readonly mergeComplete: string) {}
}

/**
 * Each workflow policy key can produce several guards. GuardHintCommands carries the resolved
 * commands.guardHints strings to the guards that print gated commands, separately from BaseRuleConfig.
 */
type RuleFactory = (config: BaseRuleConfig, guardHints: GuardHintCommands) => readonly Rule[];
const BUILT_IN_RULE_MAP: Record<string, RuleFactory> = {
    'branch-creation-guard': (c: BaseRuleConfig) => [new BranchCreationGuardRule(c as BranchCreationGuardConfig)],
    // THE TWO COLLAPSED POLICIES. Order inside each array is the order the rules run in, and it is the
    // same order the previous per-key registry produced.
    'pr-lifecycle-guard': (c: BaseRuleConfig, hints: GuardHintCommands) => [
        new PrCreationOrPushGuardRule(c as PrLifecycleGuardConfig, hints.upsertPr),
        new MergeInProgressGuardRule(c as PrLifecycleGuardConfig, hints.mergeComplete),
        new PrMergeGuardRule(c as PrLifecycleGuardConfig),
        new RedirectHowToMergeMainRule(c as PrLifecycleGuardConfig),
    ],
    'branch-state-guard': (c: BaseRuleConfig) => [
        new FeatureBranchGuardRule(c as BranchStateGuardConfig),
        new ReadStaleGuardRule(c as BranchStateGuardConfig),
        new MergedBranchBashGuardRule(c as BranchStateGuardConfig),
        new StaleMainBashGuardRule(c as BranchStateGuardConfig),
    ],
};

// webpieces-disable no-function-outside-class -- the existing stateless guard registry entry point
export function loadRules(config: WebpiecesRulesConfig, workspaceRoot: string, guardHints: GuardHintCommands): readonly Rule[] {
    void workspaceRoot;
    // webpieces-disable no-any-unknown -- index validated configuration by the registry's declared keys
    const map = config as unknown as Record<string, BaseRuleConfig | undefined>;
    const rules: Rule[] = [];
    for (const key of Object.keys(BUILT_IN_RULE_MAP)) rules.push(...BUILT_IN_RULE_MAP[key](map[key] ?? new EmptyRuleConfig(), guardHints));
    return rules;
}

// webpieces-disable no-function-outside-class -- existing keyless guard factory moved intact
export function loadKeylessBashRules(affectedBuildCommand: string): Rule[] {
    return [
        new WholeRepoBuildGuardRule(affectedBuildCommand),
        new CommitMessageSubstitutionGuardRule(),
        new BuildOutputPipeGuardRule(),
        new WaitSpinGuardRule(),
    ];
}
