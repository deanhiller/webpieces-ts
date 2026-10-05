import * as ts from 'typescript';

/** One actual TypeScript keyword type, never a word in a comment, string or property name. */
export class TypeKeywordSite {
    constructor(
        readonly node: ts.Node,
        readonly line: number,
        readonly column: number,
        readonly keyword: 'any' | 'unknown',
        readonly catchVariable: boolean,
    ) {}
}

/** Syntax-only analysis shared by the build gate and pre-write hook; no Program or type checker. */
export class TypeKeywords {
    parse(fileName: string, content: string): TypeKeywordSite[] {
        return this.find(ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true));
    }

    find(source: ts.SourceFile): TypeKeywordSite[] {
        const sites: TypeKeywordSite[] = [];
        const visit = (node: ts.Node): void => {
            if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
                const position = source.getLineAndCharacterOfPosition(node.getStart(source));
                sites.push(new TypeKeywordSite(node, position.line + 1, position.character + 1,
                    node.kind === ts.SyntaxKind.AnyKeyword ? 'any' : 'unknown', this.isCatchVariable(node)));
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return sites;
    }

    /** Syntax context only; consumers decide whether catch-variable types are exempt. */
    private isCatchVariable(node: ts.Node): boolean {
        let current: ts.Node | undefined = node.parent;
        while (current) {
            if (ts.isVariableDeclaration(current) && ts.isCatchClause(current.parent)) return true;
            current = current.parent;
        }
        return false;
    }
}
