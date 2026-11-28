import * as ts from 'typescript';

/** Import-aware decorator names shared by endpoint and multi-identity extraction. */
export class CanonicalDecorator {
    // webpieces-disable no-function-outside-class -- canonical import-aware AST name resolution
    static nameOf(expression: ts.Expression): string | undefined {
        for (const statement of expression.getSourceFile().statements) {
            if (
                !ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier)
            )
                continue;
            const module = statement.moduleSpecifier.text;
            if (
                ![
                    '@webpieces/core-util',
                    '@webpieces/http-routing',
                    '@webpieces/http-client-browser',
                ].includes(module) &&
                !module.endsWith('/core-util/src/http/decorators') &&
                !module.endsWith('/core-util/src/http/auth-mode') &&
                !module.endsWith('/core-util/src/http/authorization')
            )
                continue;
            const bindings = statement.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings) && ts.isIdentifier(expression)) {
                const imported = bindings.elements.find(
                    (entry: ts.ImportSpecifier) => entry.name.text === expression.text,
                );
                if (imported) return imported.propertyName?.text ?? imported.name.text;
            }
            if (
                bindings &&
                ts.isNamespaceImport(bindings) &&
                ts.isPropertyAccessExpression(expression) &&
                ts.isIdentifier(expression.expression) &&
                expression.expression.text === bindings.name.text
            )
                return expression.name.text;
        }
        return undefined;
    }
}
