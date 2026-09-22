import * as ts from 'typescript';

/**
 * Pointer-style locations, in ONE place.
 *
 * Every `UnmappedType` and every {@link ApiDocExtractionError} carries one, and they have to agree:
 * an agent that is handed two different spellings of "where" for the same file cannot tell whether
 * it is looking at one problem or two.
 */
export class SourceLocation {
    // webpieces-disable no-function-outside-class -- static helper on the class that defines the format
    static of(node: ts.Node): string {
        const file = node.getSourceFile();
        if (!file) {
            return '<unknown>';
        }
        const position = file.getLineAndCharacterOfPosition(node.getStart(file));
        return `${file.fileName}:${position.line + 1}:${position.character + 1}`;
    }
}
