import * as ts from 'typescript';

/**
 * One local TypeScript parse of one file's text, shared by every syntax rule that judges it.
 * No compiler program, no import resolution, no git: a rule walks `source` and decides the policy.
 */
export class SourceSyntax {
    readonly source: ts.SourceFile;

    constructor(fileName: string, content: string) {
        this.source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
    }

    /** 1-based line of a node's first non-trivia character. */
    lineOf(node: ts.Node): number {
        return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
    }

    /** 1-based line of a node's last character. */
    endLineOf(node: ts.Node): number {
        return this.source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    }
}
