import type { RuleGroup, Violation } from './types';

export function formatReport(relativePath: string, ruleGroups: readonly RuleGroup[]): string {
    const lines: string[] = [];
    lines.push(`\u274c webpieces ai-hooks blocked this write: ${relativePath}`);
    lines.push('');

    for (const group of ruleGroups) {
        const count = group.violations.length;
        const label = count === 1 ? '1 violation' : `${count} violations`;
        lines.push(`[${group.ruleName}] (${label})`);
        for (const v of group.violations) {
            const editPrefix = formatEditPrefix(v);
            lines.push(`  ${editPrefix}L${String(v.line)}:  ${v.snippet}`);
            lines.push(`    \u2192 ${v.message}`);
        }
        if (group.fixHint.length > 0) {
            for (const hint of group.fixHint) {
                lines.push(`  Fix: ${hint}`);
            }
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
