/**
 * `catch-must-propagate` at the build gate (#1313) — the backstop for repos that do not run the guard
 * hooks. It calls the SAME syntax-only `CatchPropagationAnalyzer` the Write/Edit guard calls, on the same
 * whole-file parse, so both runners report the same catches at the same lines (pinned by the conformance
 * spec in `@webpieces/webpieces-tooling`).
 *
 * Scoping follows the ApiLibSourceRule shape: NEW_AND_MODIFIED_CODE judges only a catch whose clause spans
 * a changed line (existing catches are grandfathered until someone touches them), NEW_AND_MODIFIED_FILES
 * every catch in a changed file, and the whole-scope modes (#1027) every catch of a touched project / the
 * repo. A failure is ONE thrown `RuleFailError` with one `Option` per site, which `RuleReporter` renders.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { DiffScope, Option, RuleFailError } from '@webpieces/rules-config';
import { ModifiedCodeMode } from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import {
    CATCH_MUST_PROPAGATE,
    CATCH_MUST_PROPAGATE_CURES,
    CATCH_MUST_PROPAGATE_DISABLE,
    CatchCure,
    CatchFinding,
    CatchPropagationAnalyzer,
} from '@webpieces/tooling-common/catch-propagation';
import { injectable, bindingScopeValues } from 'inversify';
import { CatchMustPropagateConfig } from './configs/catch-must-propagate-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ScanScope } from './scan-scope';

/** A finding located in its workspace-relative file. Data-only. */
export class LocatedCatchFinding {
    constructor(
        readonly relFile: string,
        readonly finding: CatchFinding,
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class CatchMustPropagateValidator extends CodeValidator<CatchMustPropagateConfig> {
    constructor(
        config: CatchMustPropagateConfig,
        private readonly diffScope: DiffScope,
        private readonly scanScope: ScanScope,
    ) {
        super(config, CATCH_MUST_PROPAGATE, CATCH_MUST_PROPAGATE);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode: ModifiedCodeMode | undefined = this.config.mode;
        if (mode === undefined || mode === 'OFF') return { success: true };
        const range = await this.diffScope.resolveBase(workspaceRoot);
        if (range.base === undefined) {
            console.log(`\n⏭️  Skipping ${this.name} validation (could not detect base branch)\n`);
            return { success: true };
        }
        const analyzer = new CatchPropagationAnalyzer(this.forwards());
        const found: LocatedCatchFinding[] = [];
        for (const relFile of await this.scanScope.files(workspaceRoot, mode, range.base, range.head)) {
            if (!analyzer.judges(relFile) || !fs.existsSync(path.join(workspaceRoot, relFile))) continue;
            const changed = this.scanScope.isLineScoped(mode)
                ? this.diffScope.getChangedLineNumbers(await this.diffScope.getFileDiff(workspaceRoot, relFile, range.base, range.head))
                : undefined;
            if (changed !== undefined && changed.size === 0) continue;
            for (const finding of this.judge(analyzer, workspaceRoot, relFile, changed)) {
                found.push(new LocatedCatchFinding(relFile, finding));
            }
        }
        if (found.length === 0) return { success: true };
        this.scanScope.recordSites(this.name, found.map((each: LocatedCatchFinding) => each.relFile));
        throw this.failure(found);
    }

    /** One file's findings: the whole text parsed, exactly as the guard parses the proposed file. */
    judge(analyzer: CatchPropagationAnalyzer, workspaceRoot: string, relFile: string, changed?: ReadonlySet<number>): CatchFinding[] {
        const absFile = path.join(workspaceRoot, relFile);
        const source = ts.createSourceFile(absFile, fs.readFileSync(absFile, 'utf8'), ts.ScriptTarget.Latest, true);
        return analyzer.analyze(source, changed);
    }

    /** Required by the owner schema; the loader refuses a config without it, so its absence is plumbing. */
    private forwards(): readonly string[] {
        const forwards = this.config.forwards;
        if (forwards === undefined) {
            throw new InformAiError(`${CATCH_MUST_PROPAGATE} has no "forwards" list. Add the required "forwards" array to its config entry.`);
        }
        return forwards;
    }

    private failure(found: readonly LocatedCatchFinding[]): RuleFailError {
        const message =
            `${found.length} catch(es) let the caught error go — its stack, type and cause chain are lost for good, ` +
            `and a later refusal built from its text says nothing of WHY:\n` +
            found.map((each: LocatedCatchFinding) =>
                `  ${each.relFile}:${each.finding.line} — ${each.finding.message}\n      ${each.finding.snippet}`).join('\n') +
            `\n  Last resort, per site: ${CATCH_MUST_PROPAGATE_DISABLE}`;
        return new RuleFailError(
            this.name,
            message,
            undefined,
            undefined,
            CATCH_MUST_PROPAGATE_CURES.map((cure: CatchCure) => new Option(cure.text, cure.preferred)),
        );
    }
}
