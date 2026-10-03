import { BuildPolicy } from '@webpieces/rules-sdk';

import { injectable, bindingScopeValues } from 'inversify';

import { ExecutorResult, RuleRun } from './code-validator';
import { RuleReporter } from './rule-reporter';
import { WorkspaceRoot, MatchRulesHolder } from './code-rules-context';
import { RuleSelection } from './code-rules-run-request';
import { MatchRulesChecker } from './validate-match-rules';

/** Runtime checks are composed from the owner's policy entries, rather than injected individually. */
export class BuildPolicySet {
    constructor(readonly policies: readonly BuildPolicy[]) {}
}

@injectable(bindingScopeValues.Singleton)
export class CodeRulesEngine {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        private readonly workspace: WorkspaceRoot,
        private readonly reporter: RuleReporter,
        private readonly matchRules: MatchRulesHolder,
        private readonly matchChecker: MatchRulesChecker,
        private readonly selection: RuleSelection,
        private readonly checks: BuildPolicySet,
    ) {}

    /**
     * Every ACTIVE run: an injected built-in validator whose `shouldRun()` is true, or an injected
     * match-rule check per configured entry that is active. Built as {@link RuleRun} value objects
     * (name + thunk) so NO DAG member is `new`-ed — the validators and the checker are injected.
     * A debug run (#1027) narrows the set to the one rule its {@link RuleSelection} names.
     */
    private activeRuns(root: string): RuleRun[] {
        const runs: RuleRun[] = [];
        for (const v of this.checks.policies) {
            if (this.selection.includes(v.name) && v.shouldRun())
                runs.push(new RuleRun(v.name, () => v.run(root)));
        }
        for (const mr of this.matchRules.rules) {
            if (this.selection.includes(mr.name) && this.matchChecker.shouldRun(mr))
                runs.push(new RuleRun(mr.name, () => this.matchChecker.runForConfig(mr, root)));
        }
        return runs;
    }

    /**
     * Run all configured code validators against the workspace. A validator runs only when
     * `shouldRun()` is true (mode not OFF and no branch/epoch escape hatch). Per-run isolation lives
     * in {@link RuleReporter} so one validator can never abort the rest.
     */
    async run(): Promise<ExecutorResult> {
        const runs = this.activeRuns(this.workspace.path);
        if (runs.length === 0) {
            console.log('\n⏭️  Skipping all code validations (all modes: OFF)\n');
            return { success: true };
        }

        console.log('\n📏 Running Code Validations\n');
        console.log(`   Active rules: ${runs.map((r: RuleRun) => r.name).join(', ')}`);
        console.log('');

        const result = await this.reporter.runValidators(runs);
        console.log(
            result.success
                ? '\n✅ All code validations passed\n'
                : '\n❌ Some code validations failed\n',
        );
        return result;
    }
}
