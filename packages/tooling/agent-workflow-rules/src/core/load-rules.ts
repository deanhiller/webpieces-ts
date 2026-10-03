import { Rule } from '@webpieces/hook-runtime';
import { BuildOutputPipeGuardRule } from './rules/build-output-pipe-guard';
import { WaitSpinGuardRule } from './rules/wait-spin-guard';
import { WholeRepoBuildGuardRule } from './rules/whole-repo-build-guard';
import { CommitMessageSubstitutionGuardRule } from './rules/commit-message-substitution-guard';

// webpieces-disable no-function-outside-class -- existing keyless guard factory moved intact
export function loadKeylessBashRules(affectedBuildCommand: string): Rule[] {
    return [
        new WholeRepoBuildGuardRule(affectedBuildCommand),
        new CommitMessageSubstitutionGuardRule(),
        new BuildOutputPipeGuardRule(),
        new WaitSpinGuardRule(),
    ];
}
