import * as ts from 'typescript';
import { TypeKeywords, TypeKeywordSite } from './type-keywords';
import { MethodLines, MethodLineSite } from './method-lines';

/** One local parse reused by syntax checks; no compiler program, import resolution or git. */
export class SourceSyntax {
    private readonly source: ts.SourceFile;

    constructor(fileName: string, content: string) {
        this.source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
    }

    keywords(): TypeKeywordSite[] { return new TypeKeywords().find(this.source); }
    methods(): MethodLineSite[] { return new MethodLines().find(this.source); }
}
