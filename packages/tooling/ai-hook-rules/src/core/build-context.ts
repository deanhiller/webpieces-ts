import * as fs from 'fs';
import * as path from 'path';

import { stripTsNoise } from './strip-ts-noise';
import { createIsLineDisabled } from './disable-directives';
import {
    ToolKind, NormalizedToolInput, NormalizedEdit,
    EditContext, FileContext, BashContext,
} from './types';

export class BuiltContexts {
    readonly fileContext: FileContext;
    readonly editContexts: readonly EditContext[];

    constructor(fileContext: FileContext, editContexts: readonly EditContext[]) {
        this.fileContext = fileContext;
        this.editContexts = editContexts;
    }
}

export function buildContexts(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    workspaceRoot: string,
): BuiltContexts {
    const filePath = input.filePath;
    const relativePath = path.relative(workspaceRoot, filePath);
    const edits = input.edits;

    const currentFileLines = readCurrentFileLines(filePath);
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const e of edits) {
        linesAdded += countLines(e.newString);
        linesRemoved += countLines(e.oldString);
    }

    const projectedFileLines =
        toolKind === 'Write'
            ? countLines(edits.length > 0 ? edits[0].newString : '')
            : currentFileLines + linesAdded - linesRemoved;

    const fileContext = new FileContext(
        toolKind,
        filePath,
        relativePath,
        workspaceRoot,
        currentFileLines,
        linesAdded,
        linesRemoved,
        projectedFileLines,
    );

    const editContexts = edits.map((e, idx) => {
        const addedContent = e.newString;
        const stripped = stripTsNoise(addedContent);
        const isLineDisabled = createIsLineDisabled(addedContent);
        return new EditContext(
            toolKind,
            idx,
            edits.length,
            filePath,
            relativePath,
            workspaceRoot,
            addedContent,
            stripped,
            addedContent.split('\n'),
            stripped.split('\n'),
            e.oldString,
            isLineDisabled,
        );
    });

    return new BuiltContexts(fileContext, editContexts);
}

export function buildBashContext(command: string, workspaceRoot: string): BashContext {
    return new BashContext(command, workspaceRoot);
}

function readCurrentFileLines(filePath: string): number {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return countLines(content);
    } catch (err: unknown) {
        // eslint-disable-next-line @webpieces/catch-error-pattern -- file-not-found is expected for new Write targets
        void err;
        return 0;
    }
}

function countLines(s: string): number {
    if (!s) return 0;
    return s.split('\n').length;
}
