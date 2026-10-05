import * as ts from 'typescript';

/** Syntax and physical line span of a named function supported by the code validators. */
export class MethodLineSite {
    constructor(readonly name: string, readonly line: number, readonly endLine: number, readonly node: ts.Node) {}

    get lines(): number { return this.endLine - this.line + 1; }

    get key(): string {
        const owners: string[] = [];
        let parent: ts.Node | undefined = this.node.parent;
        while (parent) {
            if ((ts.isClassDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name)
                owners.unshift(parent.name.getText());
            parent = parent.parent;
        }
        return [...owners, this.name].join('.');
    }
}

/** Local syntax traversal shared by method-size checks. Does not resolve imports or infer types. */
export class MethodLines {
    parse(fileName: string, content: string): MethodLineSite[] {
        return this.find(ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true));
    }

    find(source: ts.SourceFile): MethodLineSite[] {
        const sites: MethodLineSite[] = [];
        const visit = (node: ts.Node): void => {
            let name: string | undefined;
            if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) name = node.name.getText(source);
            if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.getText(source);
            if (name) {
                const start = source.getLineAndCharacterOfPosition(node.getStart(source));
                const end = source.getLineAndCharacterOfPosition(node.getEnd());
                sites.push(new MethodLineSite(name, start.line + 1, end.line + 1, node));
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return sites;
    }
}
