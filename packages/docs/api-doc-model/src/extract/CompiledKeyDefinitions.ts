import * as fs from 'node:fs';
import * as ts from 'typescript';

/**
 * Where a ContextKey declared in a PUBLISHED package is actually DEFINED.
 *
 * A consumer resolves `@webpieces/core-util` (or any built library) to its `.d.ts`, and declaration
 * emit DROPS initializers: `static readonly REQUEST_ID: ContextKey<string, "untrusted">;`. The
 * definition — `ContextKey.untrusted('requestId', 'x-request-id', …)` — survives only in the
 * compiled `.js` that ships beside it. So for a declaration in a `.d.ts` this reads that sibling
 * `.js` SYNTACTICALLY (it is never executed) and returns the initializer the declaration lost.
 *
 * The nodes returned are NOT part of the type-checker's program: a caller must read them without
 * asking the checker anything (see {@link ContextKeyHeaderFolder}, which accepts only literal
 * header arguments from here).
 */
export class CompiledKeyDefinitions {
    private readonly parsed = new Map<string, ts.SourceFile | undefined>();

    /** The compiled initializer of a `.d.ts` declaration, or undefined when there is none to find. */
    initializerOf(declaration: ts.Declaration): ts.Expression | undefined {
        const declarationFile = declaration.getSourceFile();
        if (!declarationFile.isDeclarationFile) {
            return undefined;
        }
        const compiled = this.compiledFile(declarationFile.fileName);
        if (compiled === undefined) {
            return undefined;
        }
        if (ts.isPropertyDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
            const owner = declaration.parent;
            if (ts.isClassDeclaration(owner) && owner.name !== undefined) {
                return this.staticMember(compiled, owner.name.text, declaration.name.text);
            }
        }
        if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
            return this.topLevelConst(compiled, declaration.name.text);
        }
        return undefined;
    }

    private compiledFile(declarationFileName: string): ts.SourceFile | undefined {
        const jsFile = declarationFileName.replace(/\.d\.ts$/, '.js');
        if (!this.parsed.has(jsFile)) {
            this.parsed.set(
                jsFile,
                jsFile !== declarationFileName && fs.existsSync(jsFile)
                    ? ts.createSourceFile(jsFile, fs.readFileSync(jsFile, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
                    : undefined,
            );
        }
        return this.parsed.get(jsFile);
    }

    /** `class C { static M = … }` (ES2022 emit) or `C.M = …;` (down-levelled emit). */
    private staticMember(source: ts.SourceFile, className: string, member: string): ts.Expression | undefined {
        for (const statement of source.statements) {
            if (ts.isClassDeclaration(statement) && statement.name?.text === className) {
                for (const element of statement.members) {
                    if (ts.isPropertyDeclaration(element) && ts.isIdentifier(element.name) && element.name.text === member && element.initializer) {
                        return element.initializer;
                    }
                }
            }
            const assigned = this.assignment(statement, (target: ts.PropertyAccessExpression) =>
                ts.isIdentifier(target.expression) && target.expression.text === className && target.name.text === member);
            if (assigned !== undefined) {
                return assigned;
            }
        }
        return undefined;
    }

    /** `const X = …` or `exports.X = …`. */
    private topLevelConst(source: ts.SourceFile, name: string): ts.Expression | undefined {
        for (const statement of source.statements) {
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
                        return declaration.initializer;
                    }
                }
            }
            const assigned = this.assignment(statement, (target: ts.PropertyAccessExpression) =>
                ts.isIdentifier(target.expression) && target.expression.text === 'exports' && target.name.text === name);
            if (assigned !== undefined) {
                return assigned;
            }
        }
        return undefined;
    }

    private assignment(
        statement: ts.Statement,
        matches: (target: ts.PropertyAccessExpression) => boolean,
    ): ts.Expression | undefined {
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
            return undefined;
        }
        const binary = statement.expression;
        if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(binary.left)) {
            return undefined;
        }
        return matches(binary.left) ? binary.right : undefined;
    }
}
