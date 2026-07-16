import { BaseRuleConfig } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { CodeValidator, ExecutorResult, RuleRun } from './code-validator';
import { RuleReporter } from './rule-reporter';
import { WorkspaceRoot, MatchRulesHolder } from './code-rules-context';
import { MatchRulesChecker } from './validate-match-rules';
import { MaxMethodLinesValidator } from './validate-modified-methods';
import { MaxFileLinesValidator } from './validate-modified-files';
import { RequireReturnTypeValidator } from './validate-return-types';
import { NoInlineTypeLiteralsValidator } from './validate-no-inline-types';
import { NoAnyUnknownValidator } from './validate-no-any-unknown';
import { NoImplicitAnyValidator } from './validate-no-implicit-any';
import { PrismaValidateDtosValidator } from './validate-dtos';
import { PrismaConverterValidator } from './validate-prisma-converters';
import { NoDestructureValidator } from './validate-no-destructure';
import { CatchErrorPatternValidator } from './validate-catch-error-pattern';
import { NoUnmanagedExceptionsValidator } from './validate-no-unmanaged-exceptions';
import { NoDirectApiResolverValidator } from './validate-no-direct-api-resolver';
import { NoSymbolDiTokensValidator } from './validate-no-symbol-di-tokens';
import { NoProcessExitOutsideMainValidator } from './validate-no-process-exit-outside-main';
import { NoFunctionOutsideClassValidator } from './validate-no-function-outside-class';
import { InjectAnnotationNotNeededForConcreteClassValidator } from './validate-inject-annotation-not-needed-for-concrete-class';
import { FrameworkTagValidator } from './validate-framework-tag';
import { RoleTagValidator } from './validate-role-tag';

/**
 * Owns running the code-rules suite. Every built-in validator is injected as a singleton (its config
 * is bound in the container at bootstrap), so this class IS the code-rules DI DAG the design graph
 * draws. The per-entry match-rules validators are the one exception — they are config-per-instance,
 * so they are built from the injected {@link MatchRulesHolder}.
 */
@injectable(bindingScopeValues.Singleton)
export class CodeRulesEngine {
    // webpieces-disable max-lines-new-methods -- the built-in validator set is flat; each is one injected field
    constructor(
        private readonly workspace: WorkspaceRoot,
        private readonly reporter: RuleReporter,
        private readonly matchRules: MatchRulesHolder,
        private readonly matchChecker: MatchRulesChecker,
        private readonly maxMethodLines: MaxMethodLinesValidator,
        private readonly maxFileLines: MaxFileLinesValidator,
        private readonly requireReturnType: RequireReturnTypeValidator,
        private readonly noInlineTypeLiterals: NoInlineTypeLiteralsValidator,
        private readonly noAnyUnknown: NoAnyUnknownValidator,
        private readonly noImplicitAny: NoImplicitAnyValidator,
        private readonly prismaValidateDtos: PrismaValidateDtosValidator,
        private readonly prismaConverter: PrismaConverterValidator,
        private readonly noDestructure: NoDestructureValidator,
        private readonly catchErrorPattern: CatchErrorPatternValidator,
        private readonly noUnmanagedExceptions: NoUnmanagedExceptionsValidator,
        private readonly noDirectApiResolver: NoDirectApiResolverValidator,
        private readonly noSymbolDiTokens: NoSymbolDiTokensValidator,
        private readonly noProcessExitOutsideMain: NoProcessExitOutsideMainValidator,
        private readonly noFunctionOutsideClass: NoFunctionOutsideClassValidator,
        private readonly injectAnnotationNotNeeded: InjectAnnotationNotNeededForConcreteClassValidator,
        private readonly frameworkTag: FrameworkTagValidator,
        private readonly roleTag: RoleTagValidator,
    ) {}

    /** The 18 injected built-in validators, in run order. */
    private builtIns(): CodeValidator<BaseRuleConfig>[] {
        return [
            this.maxMethodLines, this.maxFileLines, this.requireReturnType, this.noInlineTypeLiterals,
            this.noAnyUnknown, this.noImplicitAny, this.prismaValidateDtos, this.prismaConverter,
            this.noDestructure, this.catchErrorPattern, this.noUnmanagedExceptions, this.noDirectApiResolver,
            this.noSymbolDiTokens, this.noProcessExitOutsideMain, this.noFunctionOutsideClass,
            this.injectAnnotationNotNeeded, this.frameworkTag, this.roleTag,
        ];
    }

    /**
     * Every ACTIVE run: an injected built-in validator whose `shouldRun()` is true, or an injected
     * match-rule check per configured entry that is active. Built as {@link RuleRun} value objects
     * (name + thunk) so NO DAG member is `new`-ed — the validators and the checker are injected.
     */
    private activeRuns(root: string): RuleRun[] {
        const runs: RuleRun[] = [];
        for (const v of this.builtIns()) {
            if (v.shouldRun()) runs.push(new RuleRun(v.name, () => v.run(root)));
        }
        for (const mr of this.matchRules.rules) {
            if (this.matchChecker.shouldRun(mr)) runs.push(new RuleRun(mr.name, () => this.matchChecker.runForConfig(mr, root)));
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
        console.log(result.success ? '\n✅ All code validations passed\n' : '\n❌ Some code validations failed\n');
        return result;
    }
}
