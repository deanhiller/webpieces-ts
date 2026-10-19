import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildPolicy, BuildPolicyResult } from '@webpieces/rules-sdk';
import { AbstractRule, DiffScope, RuleFailError, RuleFileScope } from '@webpieces/rules-config';
import { ScanScope } from '@webpieces/code-rules';
import { LocalRule, LocalRuleConfig } from './local-rule';
import { LocalRuleJudge, LocalRuleVerdict } from './local-rule-judge';

/** A verdict located in its workspace-relative file. Data-only. */
export class LocatedLocalVerdict {
    constructor(
        readonly relFile: string,
        readonly verdict: LocalRuleVerdict,
    ) {}
}

/**
 * A local rule at the build gate (`wp-build` / the PR gate, through `validate-code`): the backstop for a
 * repo that does not run the guard hooks. It reads each in-scope file WHOLE and calls the same
 * {@link LocalRuleJudge} the Write/Edit guard calls, so both runners report the same sites at the same lines.
 *
 * The file set follows `mode` exactly as the built-in rules do (`ScanScope`): NEW_AND_MODIFIED_CODE judges
 * only findings on changed lines of changed files, NEW_AND_MODIFIED_FILES every finding in a changed file,
 * MODIFIED_PROJECTS / RUN_EVERY_TIME every file of each touched project / of the repo. The repo's
 * top-level `excludePaths` and the rule's own are applied to that listing; OFF and the epoch and branch
 * switches are checked by `shouldRun()` here and again by the build runner. A failure is ONE thrown
 * `RuleFailError` listing every site, rendered by the build runner.
 *
 * The files come from the {@link ScanScope} it is handed: the gate's (`GateScanScope`, no restriction), or a
 * debug run's (#1330), restricted to `--projects`. Every site found is recorded there too, so a debug run
 * counts them per project exactly as it does for a built-in rule.
 */
export class LocalBuildPolicy extends AbstractRule<LocalRuleConfig> implements BuildPolicy {
    private readonly judge: LocalRuleJudge;
    private readonly diffScope = new DiffScope();

    constructor(
        config: LocalRuleConfig,
        private readonly rule: LocalRule,
        private readonly globalExcludePaths: readonly string[],
        private readonly scanScope: ScanScope,
    ) {
        super(config, rule.id, rule.id);
        this.judge = new LocalRuleJudge(rule);
    }

    async run(workspaceRoot: string): Promise<BuildPolicyResult> {
        const found = await new RuleFileScope().runWithin(this.fileExclusions(this.globalExcludePaths), async () => this.scan(workspaceRoot));
        if (found === undefined || found.length === 0) return new BuildPolicyResult(true);
        this.scanScope.recordSites(this.name, found.map((each: LocatedLocalVerdict) => each.relFile));
        throw this.failure(found);
    }

    /** undefined when the diff base cannot be found, so a diff-scoped mode has nothing to compare against. */
    private scan(workspaceRoot: string): LocatedLocalVerdict[] | undefined {
        const mode = this.config.mode;
        if (mode === undefined || mode === 'OFF') return [];
        const range = this.diffScope.resolveBase(workspaceRoot);
        if (range.base === undefined && mode !== 'RUN_EVERY_TIME') {
            console.log(`\n⏭️  Skipping ${this.name} validation (could not detect base branch)\n`);
            return undefined;
        }
        const base = range.base ?? '';
        const found: LocatedLocalVerdict[] = [];
        for (const relFile of this.scanScope.files(workspaceRoot, mode, base, range.head, { tsOnly: false })) {
            const absFile = path.join(workspaceRoot, relFile);
            if (!this.judge.judges(relFile) || !fs.existsSync(absFile)) continue;
            const changed = mode === 'NEW_AND_MODIFIED_CODE'
                ? this.diffScope.getChangedLineNumbers(this.diffScope.getFileDiff(workspaceRoot, relFile, base, range.head))
                : undefined;
            if (changed !== undefined && changed.size === 0) continue;
            for (const verdict of this.judge.judge(relFile, fs.readFileSync(absFile, 'utf8'), this.config, changed)) {
                found.push(new LocatedLocalVerdict(relFile, verdict));
            }
        }
        return found;
    }

    private failure(found: readonly LocatedLocalVerdict[]): RuleFailError {
        const message =
            `${found.length} site(s) break the repo-local rule ${this.name} — ${this.rule.description}\n` +
            found.map((each: LocatedLocalVerdict) =>
                `  ${each.relFile}:${each.verdict.line} — ${each.verdict.message}\n      ${each.verdict.snippet}`).join('\n') +
            `\n  Last resort, per site: ${this.judge.disableComment()}`;
        return new RuleFailError(this.name, message, undefined, undefined, this.rule.cures);
    }
}
