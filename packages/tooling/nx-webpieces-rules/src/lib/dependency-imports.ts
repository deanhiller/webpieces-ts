import * as ts from 'typescript';
import { isBuiltin } from 'node:module';

export class DependencyImport {
    constructor(
        readonly specifier: string,
        readonly line: number,
        readonly runtime: boolean,
        readonly unresolved: string = '',
    ) {}
}

/** Parse syntax, including createRequire aliases; prose and relative imports are not packages. */
export class DependencyImports {
    read(text: string, file: string): DependencyImport[] {
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        if (source.isDeclarationFile)
            return this.specifiers(source).map(
                (entry: DependencyImport) =>
                    new DependencyImport(entry.specifier, entry.line, false, entry.unresolved),
            );
        const emitted = ts.transpileModule(text, {
            fileName: file,
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2022,
                experimentalDecorators: true,
                emitDecoratorMetadata: true,
                importHelpers: true,
            },
        }).outputText;
        const runtime = new Set(
            this.specifiers(ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true)).map(
                (entry: DependencyImport) => entry.specifier,
            ),
        );
        const entries = this.specifiers(source).map(
            (entry: DependencyImport) =>
                new DependencyImport(
                    entry.specifier,
                    entry.line,
                    runtime.has(entry.specifier),
                    entry.unresolved,
                ),
        );
        if (
            runtime.has('tslib') &&
            !entries.some((entry: DependencyImport) => entry.specifier === 'tslib')
        )
            entries.push(new DependencyImport('tslib', 1, true));
        return entries;
    }

    packageName(specifier: string): string | undefined {
        if (
            !specifier ||
            /^[./#]/u.test(specifier) ||
            isBuiltin(specifier) ||
            /^[a-z]+:/iu.test(specifier)
        )
            return undefined;
        return specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0];
    }

    private collectAliases(
        source: ts.SourceFile,
        aliases: Set<string>,
        artifactAliases: Set<string>,
    ): void {
        const collect = (node: ts.Node): void => {
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                ts.isCallExpression(node.initializer) &&
                /(?:^|\.)createRequire$/u.test(node.initializer.expression.getText(source))
            ) {
                const anchor = node.initializer.arguments[0]?.getText(source);
                if (anchor === 'import.meta.url' || anchor === '__filename')
                    aliases.add(node.name.text);
                else artifactAliases.add(node.name.text);
            }
            ts.forEachChild(node, collect);
        };
        collect(source);
    }

    private specifiers(source: ts.SourceFile): DependencyImport[] {
        const result: DependencyImport[] = [];
        const aliases = new Set(['require']);
        const artifactAliases = new Set<string>();
        this.collectAliases(source, aliases, artifactAliases);
        const add = (node: ts.Node | undefined): void => {
            if (!node) return;
            if (!ts.isStringLiteralLike(node)) {
                result.push(
                    new DependencyImport(
                        '',
                        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                        false,
                        node.getText(source),
                    ),
                );
                return;
            }
            result.push(
                new DependencyImport(
                    node.text,
                    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                    true,
                ),
            );
        };
        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                add(node.moduleSpecifier);
            else if (
                ts.isImportEqualsDeclaration(node) &&
                ts.isExternalModuleReference(node.moduleReference)
            )
                add(node.moduleReference.expression);
            else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
                add(node.argument.literal);
            else if (ts.isCallExpression(node)) {
                if (ts.isIdentifier(node.expression) && artifactAliases.has(node.expression.text)) {
                    result.push(
                        new DependencyImport(
                            '',
                            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                            false,
                            `artifact-anchored createRequire: ${node.getText(source)}`,
                        ),
                    );
                    return;
                }
                if (
                    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && aliases.has(node.expression.text))
                )
                    add(node.arguments[0]);
                else if (
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === 'resolve' &&
                    ts.isIdentifier(node.expression.expression) &&
                    aliases.has(node.expression.expression.text)
                )
                    add(node.arguments[0]);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return result;
    }
}
