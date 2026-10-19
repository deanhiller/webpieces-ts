import * as fs from 'fs';
import { InformAiError } from '@webpieces/tooling-common';
import { NormalizedToolInput, ToolKind } from '../protocol';

/** Character range in the final proposed file. Empty ranges record deletion sites. */
export class ChangedRange {
    constructor(readonly start: number, readonly end: number) {}
}

export class ProposedContent {
    constructor(readonly original: string, readonly text: string, readonly changes: readonly ChangedRange[]) {}

    changedLines(): ReadonlySet<number> {
        const lines = new Set<number>();
        for (const range of this.changes) {
            const startLine = this.text.slice(0, range.start).split('\n').length;
            const endLine = this.text.slice(0, Math.max(range.start, range.end - 1)).split('\n').length;
            for (let line = startLine; line <= endLine; line++) lines.add(line);
        }
        return lines;
    }
}

/** Lazily projects an operation in memory; existing non-syntax rules need not read the file. */
export class ProposedFile {
    private content: ProposedContent | null = null;

    constructor(private readonly tool: ToolKind, private readonly input: NormalizedToolInput) {}

    read(): ProposedContent {
        if (this.content) return this.content;
        const original = fs.existsSync(this.input.sourcePath) ? fs.readFileSync(this.input.sourcePath, 'utf8') : '';
        if (this.tool === 'Write') {
            const text = this.input.edits[0]?.newString ?? '';
            this.content = new ProposedContent(original, text, [new ChangedRange(0, text.length)]);
            return this.content;
        }
        let text = original;
        let changes: ChangedRange[] = [];
        for (const edit of this.input.edits) {
            if (!edit.oldString) throw new InformAiError(`Cannot project edit of ${this.input.filePath}: old_string is empty. Use Write for a complete file.`);
            let offset = 0;
            let count = 0;
            while (true) {
                const start = text.indexOf(edit.oldString, offset);
                if (start < 0) break;
                if (!edit.replaceAll && text.indexOf(edit.oldString, start + edit.oldString.length) >= 0)
                    throw new InformAiError(`Cannot project edit of ${this.input.filePath}: old_string matches multiple locations. Supply unique context or replace_all.`);
                const end = start + edit.oldString.length;
                if (edit.oldString === edit.newString) {
                    count++;
                    offset = end;
                    if (!edit.replaceAll) break;
                    continue;
                }
                const delta = edit.newString.length - edit.oldString.length;
                changes = changes.map((range: ChangedRange): ChangedRange => range.end < start ? range
                    : range.start > end ? new ChangedRange(range.start + delta, range.end + delta)
                    : new ChangedRange(Math.min(range.start, start), Math.max(start + edit.newString.length, range.end + delta)));
                let prefix = 0;
                while (prefix < edit.oldString.length && prefix < edit.newString.length && edit.oldString[prefix] === edit.newString[prefix]) prefix++;
                let suffix = 0;
                while (suffix < edit.oldString.length - prefix && suffix < edit.newString.length - prefix
                    && edit.oldString[edit.oldString.length - suffix - 1] === edit.newString[edit.newString.length - suffix - 1]) suffix++;
                changes.push(new ChangedRange(start + prefix, start + edit.newString.length - suffix));
                text = text.slice(0, start) + edit.newString + text.slice(end);
                count++;
                offset = start + edit.newString.length;
                if (!edit.replaceAll) break;
            }
            if (count === 0) throw new InformAiError(`Cannot project edit of ${this.input.filePath}: old_string does not match the current file. Read the file and retry with current context.`);
        }
        this.content = new ProposedContent(original, text, text === original ? [] : changes);
        return this.content;
    }
}
