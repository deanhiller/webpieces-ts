import { Option, writeTemplateIfMissing } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import {
    CATCH_MUST_PROPAGATE,
    CATCH_MUST_PROPAGATE_CURES,
    CATCH_MUST_PROPAGATE_DISABLE,
    CatchCure,
    CatchFinding,
    CatchPropagationAnalyzer,
} from '@webpieces/tooling-common/catch-propagation';
import type { FileContext } from '@webpieces/hook-runtime';
import { DisableEscape, FileRuleBase, FixHint, Violation } from '@webpieces/hook-runtime';
import { SourceContributionConfig } from '../source-contribution-config';
import { sourceAnalysis } from '../source-analysis';

/**
 * `catch-must-propagate` at Write/Edit time (#1313) — the FIRST rule on the shared AST (#1111).
 *
 * It judges the PROPOSED file (the whole post-edit text, projected in memory by ProposedFile and parsed
 * once by SourceAnalysis), with the same `CatchPropagationAnalyzer` the build gate's validator calls, so
 * the guard and `wp-build` reach the same verdict at the same line. Under NEW_AND_MODIFIED_CODE only a
 * catch whose clause spans a line this edit changed is judged; every other non-OFF mode judges the whole
 * proposed file. Test files are not judged (see `CatchPropagationAnalyzer.judges`).
 */
export class CatchMustPropagateRule extends FileRuleBase<SourceContributionConfig> {
    constructor(config: SourceContributionConfig) { super(config, CATCH_MUST_PROPAGATE, CATCH_MUST_PROPAGATE); }

    readonly description = 'A caught error must propagate whole: rethrown, thrown as a cause, forwarded, returned or stored — never replaced by its message.';
    override readonly files = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

    get fixHint(): FixHint {
        return new FixHint(
            'This catch lets the caught error go, so its stack, type and cause chain are lost for good.',
            'Carry the error itself out of the catch — pick one:',
            CATCH_MUST_PROPAGATE_CURES.map((cure: CatchCure) => new Option(cure.text, cure.preferred)),
            new DisableEscape(true, CATCH_MUST_PROPAGATE_DISABLE),
        );
    }

    check(ctx: FileContext): readonly Violation[] {
        const analyzer = new CatchPropagationAnalyzer(this.forwards());
        if (!analyzer.judges(ctx.relativePath)) return [];
        const syntax = sourceAnalysis.forFile(ctx);
        const changed = this.config.mode === 'NEW_AND_MODIFIED_CODE' ? syntax.content.changedLines() : undefined;
        const findings = analyzer.analyze(syntax.proposed.source, changed);
        if (findings.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return findings.map((finding: CatchFinding) => new Violation(finding.line, finding.snippet, finding.message));
    }

    /** Required by the owner schema; the loader refuses a config without it, so its absence is plumbing. */
    private forwards(): readonly string[] {
        const forwards = this.config.forwards;
        if (forwards === undefined) {
            throw new InformAiError(`${CATCH_MUST_PROPAGATE} has no "forwards" list. Add the required "forwards" array to its config entry.`);
        }
        return forwards;
    }
}
