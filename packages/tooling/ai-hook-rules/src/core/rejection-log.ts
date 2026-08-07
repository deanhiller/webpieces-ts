import * as fs from 'fs';
import * as path from 'path';

import { dotWebpieces, RepoRootFinder } from '@webpieces/rules-config';
import { REJECTIONS_STREAM } from './log-streams';

import type { ToolKind, NormalizedToolInput, BlockedResult } from './types';
import { logStream } from './log-stream';
import { toError } from './to-error';

/**
 * The rejection index and its detail files, BOTH inside the `rejections/` stream directory, both
 * named by the same writer key:
 *
 *   logs/rejections/<sid>-<agent>-<hook>.log      ← the index (one line per block)
 *   logs/rejections/<sid>-<agent>-<hook>/         ← its detail dir, SAME key
 *       writeInfo-<epochMs>.md
 *
 * The detail files used to be `hooks/<YYYY-MM-DD>/writeInfo-<epochMs>.md` — a directory keyed only by
 * the DATE, shared by every writer in the tree, written with a raw `writeFileSync`. Two agents blocked
 * in the same millisecond produced the same path and one silently overwrote the other's evidence. The
 * comment that licensed it claimed a per-worktree log has exactly one writer; LogStream's class
 * comment is the measurement that disproves it (parallel PreToolUse hooks, non-isolated subagents and
 * multiple Claude Code windows all share a tree). Naming the directory after the LOG THAT POINTS AT IT
 * gives it the same one-owner-by-construction property the log itself has, and makes the pointer
 * readable: the index line, the directory and the file are one name.
 *
 * RETENTION is therefore filename-based, not directory-date-based: there is no date level left, so
 * `DetailPruner` parses `<epochMs>` out of each `writeInfo-*.md` (no `stat` call) and removes any
 * stream directory left empty. Every delete is `force: true` and failures are swallowed, so concurrent
 * agents racing the same week-old files is harmless.
 */
const DETAIL_PREFIX = 'writeInfo-';
const DETAIL_SUFFIX = '.md';
const DETAIL_RE = /^writeInfo-(\d+)\.md$/;
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
        // `.webpieces/` lives at the repo root, NOT the AI's cwd — resolve it so a hook fired while
        // the AI is in a subdirectory never scatters a stray `<subdir>/.webpieces` tree.
        const root = new RepoRootFinder().resolveRepoRoot(cwd);
        const now = new Date();
        const timestamp = now.toISOString();
        const epochMs = String(now.getTime());

        // LOCAL scope — a rejection is this worktree's event. WHICH writer's event is answered by the
        // stream prefix, on the index AND on its detail directory, so neither can collide.
        const logsDir = dotWebpieces.logsFile(root, REJECTIONS_STREAM);
        // The detail directory is the writer key with NO extension, sitting beside the `.log` that
        // indexes it — so index and details share one owner, one level down inside the stream dir.
        const detailDirName = logStream.writerFile('');
        const detailDir = path.join(logsDir, detailDirName);
        fs.mkdirSync(detailDir, { recursive: true });

        const relativePath = computeRelativePath(input.filePath, root);
        const ruleNames = extractRuleNames(result.report);
        const detailFileName = `${DETAIL_PREFIX}${epochMs}${DETAIL_SUFFIX}`;
        // Relative to `rejections/` — the index's own directory — so the pointer resolves from where
        // the reader found the line, and reads as the log's own name plus a file.
        const detailRelPath = `${detailDirName}/${detailFileName}`;

        const detail = buildDetailContent(timestamp, toolKind, relativePath, ruleNames, result.report, input);
        fs.writeFileSync(path.join(detailDir, detailFileName), detail);

        const logPath = path.join(logsDir, logStream.writerFile('.log'));
        rotateLogFile(logPath, path.join(logsDir, logStream.writerFile('.1.log')));

        // APPEND-ONLY, and `fault=` is spelled exactly as the L0 sh log spells it. A fault-S storm
        // previously landed here as a couple of lines attributed to whatever rule the report happened
        // to cite, with nothing anywhere identifying L0 as the cause. (WHO made the call is answered by
        // the filename, which logStream prefixes with session/agent/hook — not by a column here.)
        const logLine = `[${timestamp}]\t${toolKind}\t${relativePath}\t[${ruleNames.join(',')}]\t${detailRelPath}\tfault=${result.fault}\n`;
        fs.appendFileSync(logPath, logLine);

        detailPruner.prune(logsDir, MAX_AGE_DAYS);
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

/**
 * The rule names a block report cites — every `[<rule-name>] (` header it opens with. Exported because
 * two audit streams need the same answer from the same regex: this file's rejection index, and the
 * `rule=` field guard-invocations.log now carries (see InvocationLog.finish). Two scrapers would be
 * two answers to one question.
 */
// webpieces-disable no-function-outside-class -- pure regex scraper beside this module's other module-scope helpers; exported so the invocation log and the rejection index scrape rule names with the SAME code.
export function extractRuleNames(report: string): string[] {
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

/**
 * The 7-day sweep over rejection DETAIL files.
 *
 * A class rather than four module-scope helpers because the four belong together: `prune` is the
 * policy and the other three are the swallow-everything filesystem calls it is built from, none of
 * which means anything on its own.
 *
 * The age comes out of the FILENAME, not out of `stat` — the epoch millis are already in the name, so
 * a sweep costs one `readdir` per stream directory and no syscall per file. (The old scheme could
 * delete a whole `hooks/<YYYY-MM-DD>/` in one recursive `rm` because the date WAS the directory; the
 * directory is now the WRITER, which never expires, so expiry moved down one level.)
 *
 * IDEMPOTENT AND RACE-TOLERANT ON PURPOSE. Several agents sweep the same directory concurrently, so
 * two processes will regularly try to unlink the same week-old file and to rmdir the same emptied
 * directory. `force: true` makes an already-gone target a no-op, an rmdir of a still-populated (or
 * already-removed) directory fails harmlessly, and every error is swallowed: the loser of the race
 * does nothing and reports nothing, which is the correct outcome — the file is gone either way.
 */
class DetailPruner {
    prune(logsDir: string, maxAgeDays: number): void {
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        for (const dirName of this.readdirOrEmpty(logsDir)) {
            const dir = path.join(logsDir, dirName);
            if (!this.isDirectory(dir)) continue;
            const names = this.readdirOrEmpty(dir);
            let removed = 0;
            for (const name of names) {
                const match = DETAIL_RE.exec(name);
                if (match === null) continue;
                if (Number(match[1]) >= cutoff) continue;
                this.removeFile(path.join(dir, name));
                removed += 1;
            }
            // Only a directory we just emptied is a candidate, and the removal is a NON-recursive rmdir
            // on purpose: it fails harmlessly if a concurrent writer dropped a fresh detail in between,
            // so the sweep can never take a file it did not decide was expired.
            if (removed > 0 && removed === names.length) this.removeEmptyDir(dir);
        }
    }

    private readdirOrEmpty(dir: string): string[] {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readdirSync(dir);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    private isDirectory(target: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.statSync(target).isDirectory();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    // `force: true` is what makes the concurrent sweep harmless: a file another agent already deleted
    // is a no-op rather than an ENOENT.
    private removeFile(target: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.rmSync(target, { force: true });
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    // NON-recursive by design — see prune(). This must refuse a directory that is not empty.
    private removeEmptyDir(target: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.rmdirSync(target);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }
}

const detailPruner = new DetailPruner();
