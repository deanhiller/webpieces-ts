/**
 * Token Resolver
 *
 * Canonicalizes a DI token expression (the argument of @inject(...), @multiInject(...),
 * @provideSingletonAs(...), or bind(...)) into a stable string key so that a token
 * DEFINITION (e.g. `TYPES.Counter` in one file) and its BIND SITE (e.g.
 * `bind(TYPES.Counter)` in another package) resolve to the same key.
 *
 * Key forms:
 *   - Symbol.for('X')  → "symbol.for:X"       (global symbol registry — string key is identity)
 *   - Symbol('X')      → "symbol:<file>#<name>" (per-declaration identity)
 *   - class-as-token   → "class:<file>#<Name>"  (e.g. @inject(HeaderMethods), bind(X).toSelf())
 *   - anything else    → "expr:<file>#<text>"   (best-effort fallback)
 */

import * as ts from 'typescript';
import * as path from 'path';
import { TokenRef } from './model';

/** Workspace-relative posix path for a source file. */
export function relativeFile(workspaceRoot: string, sourceFile: ts.SourceFile): string {
    return path.relative(workspaceRoot, sourceFile.fileName).split(path.sep).join('/');
}

/** Match a `Symbol.for('X')` or `Symbol('X')` call; returns the TokenRef key core, or null. */
function symbolCallKey(init: ts.Expression, declFile: string, declName: string): string | null {
    if (!ts.isCallExpression(init)) return null;
    const callee = init.expression;
    const arg = init.arguments[0];
    const argText = arg && ts.isStringLiteralLike(arg) ? arg.text : null;

    // Symbol.for('X')
    if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Symbol' &&
        callee.name.text === 'for'
    ) {
        return argText !== null ? `symbol.for:${argText}` : `symbol.for:${declFile}#${declName}`;
    }

    // Symbol('X')
    if (ts.isIdentifier(callee) && callee.text === 'Symbol') {
        return `symbol:${declFile}#${argText ?? declName}`;
    }

    return null;
}

/** Extract the property/variable name a declaration binds. */
function declaredName(decl: ts.Declaration): string {
    const named = decl as ts.NamedDeclaration;
    if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteralLike(named.name))) {
        return named.name.text;
    }
    return '<anonymous>';
}

/** Pull the initializer expression off a property-assignment or variable declaration. */
function declarationInitializer(decl: ts.Declaration): ts.Expression | null {
    if (ts.isPropertyAssignment(decl)) return decl.initializer;
    if (ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
    if (ts.isPropertyDeclaration(decl) && decl.initializer) return decl.initializer;
    return null;
}

/**
 * Resolve a token expression to its canonical key + display text.
 *
 * Uses the type checker to follow the expression (identifier or property access,
 * possibly imported from another package) to its declaration, then inspects the
 * declaration's initializer for Symbol.for / Symbol calls.
 */
export function resolveTokenKey(
    expr: ts.Expression,
    checker: ts.TypeChecker,
    workspaceRoot: string,
): TokenRef {
    const display = expr.getText();

    let symbol = checker.getSymbolAtLocation(expr);
    // For `TYPES.Counter` the symbol is on the property name; for a bare identifier it
    // may be an import alias — follow aliases to the original declaration.
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
    }

    const decl = symbol?.declarations?.[0];
    if (!decl) {
        return new TokenRef(`expr:<unresolved>#${display}`, display);
    }

    const declFile = relativeFile(workspaceRoot, decl.getSourceFile());
    const name = declaredName(decl);

    if (ts.isClassDeclaration(decl)) {
        return new TokenRef(`class:${declFile}#${name}`, display);
    }

    const init = declarationInitializer(decl);
    if (init) {
        const key = symbolCallKey(init, declFile, name);
        if (key) return new TokenRef(key, display);
    }

    return new TokenRef(`expr:${declFile}#${name}`, display);
}

/** Build the class-as-token key for a class declaration (bind(X).toSelf(), @provideSingleton). */
export function classTokenKey(
    cls: ts.ClassDeclaration,
    workspaceRoot: string,
): TokenRef {
    const file = relativeFile(workspaceRoot, cls.getSourceFile());
    const name = cls.name ? cls.name.text : '<anonymous>';
    return new TokenRef(`class:${file}#${name}`, name);
}
