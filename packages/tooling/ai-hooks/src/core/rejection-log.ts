import * as fs from 'fs';
import * as path from 'path';

import type { ToolKind, NormalizedToolInput, BlockedResult } from './types';

const HOOKS_DIR = '.webpieces/hooks';
const LOG_FILE = 'hook-rejection.log';
const LOG_FILE_PREV = 'hook-rejection.1.log';
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded
const MAX_AGE_DAYS = 7;

const RULE_NAME_RE = /^\[([^\]]+)\] \(/gm;

export function logRejection(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    result: BlockedResult,
    cwd: string,
): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const now = new Date();
        const timestamp = now.toISOString();
        const epochMs = String(now.getTime());
        const dateStr = timestamp.slice(0, 10);

        const hooksDir = path.join(cwd, HOOKS_DIR);
        const dayDir = path.join(hooksDir, dateStr);
        fs.mkdirSync(dayDir, { recursive: true });

        const relativePath = computeRelativePath(input.filePath, cwd);
        const ruleNames = extractRuleNames(result.report);
        const detailFileName = `writeInfo-${epochMs}.md`;
        const detailRelPath = `${dateStr}/${detailFileName}`;

        const detail = buildDetailContent(timestamp, toolKind, relativePath, ruleNames, result.report, input);
        fs.writeFileSync(path.join(dayDir, detailFileName), detail);

        const logPath = path.join(hooksDir, LOG_FILE);
        rotateLogFile(logPath, path.join(hooksDir, LOG_FILE_PREV));

        const logLine = `[${timestamp}]\t${toolKind}\t${relativePath}\t[${ruleNames.join(',')}]\t${detailRelPath}\n`;
        fs.appendFileSync(logPath, logLine);

        rotateOldDays(hooksDir, MAX_AGE_DAYS);
    } catch (err: unknown) {
        //const error = toError(err);
        void err;
    }
}

function computeRelativePath(filePath: string, cwd: string): string {
    if (filePath.startsWith(cwd)) {
        const rel = filePath.slice(cwd.length);
        if (rel.startsWith('/')) return rel.slice(1);
        return rel;
    }
    return filePath;
}

function extractRuleNames(report: string): string[] {
    const names: string[] = [];
    let match = RULE_NAME_RE.exec(report);
    while (match !== null) {
        names.push(match[1]);
        match = RULE_NAME_RE.exec(report);
    }
    RULE_NAME_RE.lastIndex = 0;
    return names;
}

function buildDetailContent(
    timestamp: string,
    toolKind: ToolKind,
    relativePath: string,
    ruleNames: string[],
    report: string,
    input: NormalizedToolInput,
): string {
    const lines: string[] = [];
    lines.push('# Hook Rejection Detail');
    lines.push('');
    lines.push(`- **Timestamp:** ${timestamp}`);
    lines.push(`- **Tool:** ${toolKind}`);
    lines.push(`- **File:** ${relativePath}`);
    lines.push(`- **Rules violated:** ${ruleNames.join(', ')}`);
    lines.push('');
    lines.push('## Report');
    lines.push('');
    lines.push('```');
    lines.push(report.trimEnd());
    lines.push('```');
    lines.push('');
    lines.push('## Content Being Written');
    lines.push('');

    if (toolKind === 'Write') {
        const content = input.edits.length > 0 ? input.edits[0].newString : '';
        lines.push('```typescript');
        lines.push(content.trimEnd());
        lines.push('```');
    } else {
        for (let i = 0; i < input.edits.length; i += 1) {
            const edit = input.edits[i];
            lines.push(`### Edit ${String(i + 1)} of ${String(input.edits.length)}`);
            lines.push('');
            lines.push('**old_string:**');
            lines.push('```typescript');
            lines.push(edit.oldString.trimEnd());
            lines.push('```');
            lines.push('');
            lines.push('**new_string:**');
            lines.push('```typescript');
            lines.push(edit.newString.trimEnd());
            lines.push('```');
            lines.push('');
        }
    }

    return lines.join('\n') + '\n';
}

function rotateLogFile(logPath: string, prevPath: string): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const stat = fs.statSync(logPath);
        if (stat.size > MAX_LOG_BYTES) {
            if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
            fs.renameSync(logPath, prevPath);
        }
    } catch (err: unknown) {
        //const error = toError(err);
        void err;
    }
}

function rotateOldDays(hooksDir: string, maxAgeDays: number): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        entries = fs.readdirSync(hooksDir);
    } catch (err: unknown) {
        //const error = toError(err);
        void err;
        return;
    }

    for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        const dirDate = new Date(entry + 'T00:00:00Z');
        if (isNaN(dirDate.getTime())) continue;
        if (dirDate.getTime() < cutoff) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                fs.rmSync(path.join(hooksDir, entry), { recursive: true, force: true });
            } catch (err: unknown) {
                //const error = toError(err);
                void err;
            }
        }
    }
}
