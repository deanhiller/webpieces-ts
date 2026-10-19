import { globMatches } from '@webpieces/rules-config';
import { MIN_DISABLE_REASON, SiteDisables, SourceSyntax } from '@webpieces/tooling-common/source-syntax';
import { LocalRule, LocalRuleConfig, LocalRuleFile, LocalRuleFinding } from './local-rule';

/** One judged site, located and ready for either runner to render. Data-only. */
export class LocalRuleVerdict {
    constructor(
        readonly line: number,
        /** The reported line's source text, trimmed. */
        readonly snippet: string,
        readonly message: string,
    ) {}
}

/**
 * The ONE place a local rule's findings become verdicts, called by BOTH runners with the same whole-file
 * text — which is what makes the Write/Edit guard and the build gate agree, line for line.
 *
 * It owns everything the rule does not: which files the rule judges, the NEW_AND_MODIFIED_CODE scoping
 * (a finding is kept when any line from `line` to `endLine` changed) and the per-site disable, which needs
 * a written reason of at least {@link MIN_DISABLE_REASON} characters to exempt a site.
 */
export class LocalRuleJudge {
    constructor(private readonly rule: LocalRule) {}

    /** The per-site escape both runners print. */
    disableComment(): string {
        return `// webpieces-disable ${this.rule.id} -- <why this one site may break the rule, at least ${MIN_DISABLE_REASON} characters>`;
    }

    /** Does the rule judge this workspace-relative path at all? */
    judges(relativePath: string): boolean {
        const normalized = relativePath.split('\\').join('/');
        return this.rule.files.some((glob: string) => globMatches(glob, normalized));
    }

    /**
     * The verdicts for one file's whole `text`. `changedLines` (1-based) is given only under
     * NEW_AND_MODIFIED_CODE; every other active mode judges the whole file.
     */
    judge(relativePath: string, text: string, config: LocalRuleConfig, changedLines?: ReadonlySet<number>): LocalRuleVerdict[] {
        const file = new LocalRuleFile(relativePath.split('\\').join('/'), new SourceSyntax(relativePath, text));
        const lines = text.split('\n');
        const disables = new SiteDisables(text, this.rule.id);
        const verdicts: LocalRuleVerdict[] = [];
        for (const finding of this.rule.check(file, config)) {
            if (!this.inScope(finding, changedLines)) continue;
            const reason = disables.reasonAt(finding.line);
            if (reason !== undefined && reason.length >= MIN_DISABLE_REASON) continue;
            const message = reason === undefined
                ? finding.message
                : `${finding.message} The \`// webpieces-disable ${this.rule.id}\` aimed at it does not exempt it: it needs a ` +
                  `written reason after \` -- \` of at least ${MIN_DISABLE_REASON} characters, the only record of why this one site may break the rule.`;
            verdicts.push(new LocalRuleVerdict(finding.line, (lines[finding.line - 1] ?? '').trim(), message));
        }
        return verdicts;
    }

    private inScope(finding: LocalRuleFinding, changedLines?: ReadonlySet<number>): boolean {
        if (changedLines === undefined) return true;
        for (let line = finding.line; line <= Math.max(finding.line, finding.endLine); line++) {
            if (changedLines.has(line)) return true;
        }
        return false;
    }
}
