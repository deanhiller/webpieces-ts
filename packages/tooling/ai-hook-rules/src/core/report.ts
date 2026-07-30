import type { RuleGroup, Violation } from './types';
import type { Option } from './fix-hint';

/**
 * How the report names the tool it just blocked. Data-only, so a class (per CLAUDE.md).
 *
 * WHY it is a parameter: the header and footer used to be hard-coded to "write". A blocked READ
 * therefore printed "\u274c webpieces ai-hooks blocked this write:" and closed with "This is a pre-write
 * check. Fix and retry the Write/Edit." \u2014 observed live, and actively misleading, because the agent is
 * told to fix and retry the one tool it did not use. A blocked Bash command printed the same thing
 * against the path `<bash>`.
 */
export class ReportSubject {
    /** Fills "blocked this ___". */
    noun: string;
    /** The closing line: what kind of check this was and which tool to retry. */
    footer: string;

    constructor(noun: string, footer: string) {
        this.noun = noun;
        this.footer = footer;
    }
}

export const WRITE_SUBJECT = new ReportSubject(
    'write', 'This is a pre-write check. Fix and retry the Write/Edit.');
export const READ_SUBJECT = new ReportSubject(
    'read', 'This is a pre-read check. Follow the fix above, then retry the Read.');
export const BASH_SUBJECT = new ReportSubject(
    'command', 'This is a pre-run check. Follow the fix above, then retry the command.');

// webpieces-disable no-function-outside-class -- pre-existing shape: this whole module is the report formatter as module-scope functions, and a lone class here would break it
export function formatReport(
    relativePath: string,
    ruleGroups: readonly RuleGroup[],
    subject: ReportSubject = WRITE_SUBJECT,
): string {
    const lines: string[] = [];
    lines.push(`\u274c webpieces ai-hooks blocked this ${subject.noun}: ${relativePath}`);
    lines.push('');

    for (const group of ruleGroups) {
        const count = group.violations.length;
        const label = count === 1 ? '1 violation' : `${count} violations`;
        lines.push(`[${group.ruleName}] (${label})`);
        const fh = group.fixHint;
        for (const v of group.violations) {
            const editPrefix = formatEditPrefix(v);
            lines.push(`  ${editPrefix}L${String(v.line)}:  ${v.snippet}`);
            // Per-occurrence override (dynamic rules), else the rule-level FixHint.violation.
            lines.push(`    \u2192 ${v.message ?? fh.violation}`);
        }
        // mainMessage may be '' (guidance already on the violation line) \u2014 skip when empty.
        if (fh.mainMessage) for (const l of fh.mainMessage.split('\n')) lines.push(`  ${l}`);
        // "Fix Option N:" numbering + "(preferred)" are framework-owned so a multi-line message
        // can never become fake options and authors never hand-write those labels.
        fh.fixOptions.forEach((opt: Option, i: number) => {
            const optLines = opt.text.split('\n');
            const tag = opt.preferred ? '(preferred) ' : '';
            lines.push(`  Fix Option ${String(i + 1)}: ${tag}${optLines[0]}`);
            for (const l of optLines.slice(1)) lines.push(`    ${l}`);
        });
        // Framework-owned disable escape (only the 9 disable-able code-style rules set this).
        if (fh.escape) {
            lines.push(fh.escape.allowed
                ? `  Escape (if truly needed): ${fh.escape.comment}`
                : '  \u{1F512} The team disabled escaping via webpieces-disable for this rule (disableAllowed:false) — it must be followed.');
        }
        lines.push('');
    }

    lines.push(subject.footer);
    lines.push('');
    return lines.join('\n');
}

function formatEditPrefix(v: Violation): string {
    if (v.editIndex !== undefined && v.editCount !== undefined && v.editCount > 1) {
        return `edit ${String(v.editIndex + 1)}/${String(v.editCount)} `;
    }
    return '';
}
