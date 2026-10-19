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

/**
 * The proposed file cannot be projected from this edit: its context is stale, ambiguous or empty, so no
 * rule may judge guessed content. A structured refusal, not a rule bug — `runRuleCheck` renders it as the
 * deny it is (never "Rule … crashed"). Worded for every harness: Claude Code, Codex and openclaw each name
 * the edit's fields differently, so the cure names the INTENT, never a tool's parameter.
 */
export class ProjectionRefusal extends InformAiError {
    readonly filePath: string;

    constructor(filePath: string, reason: string) {
        super(`Cannot judge the edit of ${filePath}: ${reason}`);
        this.name = 'ProjectionRefusal';
        this.filePath = filePath;
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
            if (!edit.oldString) throw new ProjectionRefusal(this.input.filePath, 'the edit names no existing text to replace, so there is nothing to locate. Write the complete file in one whole-file write instead, or base the edit on text the file already contains.');
            let offset = 0;
            let count = 0;
            while (true) {
                const start = text.indexOf(edit.oldString, offset);
                if (start < 0) break;
                if (!edit.replaceAll && text.indexOf(edit.oldString, start + edit.oldString.length) >= 0)
                    throw new ProjectionRefusal(this.input.filePath, 'the text to replace matches multiple locations, so the edit is ambiguous. Include enough surrounding lines that it matches exactly once, or make it an edit that replaces every occurrence.');
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
            if (count === 0) throw new ProjectionRefusal(this.input.filePath, 'the text to replace does not match the current file. Read the file again and base the edit on its current content.');
        }
        this.content = new ProposedContent(original, text, text === original ? [] : changes);
        return this.content;
    }
}
