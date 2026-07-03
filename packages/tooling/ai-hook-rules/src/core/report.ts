import type { RuleGroup, Violation } from './types';
import type { Option } from './fix-hint';

export function formatReport(relativePath: string, ruleGroups: readonly RuleGroup[]): string {
    const lines: string[] = [];
    lines.push(`\u274c webpieces ai-hooks blocked this write: ${relativePath}`);
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
        // Framework-owned memory nudge: guards flagged frequentlyHit are the git/PR/branch/merge
        // workflow gates the AI re-triggers every session. Tell it once, here, to save the correct
        // workflow to its Claude memory so the next attempt uses the gated command up front instead of
        // costing another blocked-command round-trip of tokens.
        if (fh.frequentlyHit) {
            lines.push(`  \u{1F4A1} You keep hitting [${group.ruleName}]. Save the workflow above to your memory (Claude memory file / CLAUDE.md) so you do it the right way up front and stop wasting tokens getting blocked here every session.`);
        }
        lines.push('');
    }

    lines.push('This is a pre-write check. Fix and retry the Write/Edit.');
    lines.push('');
    return lines.join('\n');
}

function formatEditPrefix(v: Violation): string {
    if (v.editIndex !== undefined && v.editCount !== undefined && v.editCount > 1) {
        return `edit ${String(v.editIndex + 1)}/${String(v.editCount)} `;
    }
    return '';
}
