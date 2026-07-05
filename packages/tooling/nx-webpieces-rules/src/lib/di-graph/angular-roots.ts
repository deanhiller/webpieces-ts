/**
 * Angular Roots
 *
 * The Angular analog of "@Controller classes are the roots". Finds the entry
 * components a DI tree is rendered "from the page/root component on down":
 *
 *   - Bootstrap root: `bootstrapApplication(AppComponent, appConfig)` in main.ts
 *     — `arguments[0]` is the root component.
 *   - Route roots: the `Routes`-typed array (and any array passed to
 *     `provideRouter(...)`). Each route object contributes its `component` /
 *     `loadComponent` component, recursing through `children`.
 *
 * Each resolved component becomes its own `DiDesign` (one tree per root, like
 * one-design-per-controller). Roots are de-duplicated by class declaration.
 */

import * as ts from 'typescript';
import { resolveClassDeclaration } from './bindings';
import { relativeFile } from './token-resolver';

/** Class declarations under the project root only (roots must be project-owned). */
function isUnderProject(sourceFile: ts.SourceFile, workspaceRoot: string, projectRoot: string): boolean {
    if (sourceFile.isDeclarationFile) return false;
    const prefix = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
    return relativeFile(workspaceRoot, sourceFile).startsWith(prefix);
}

/** Callee identifier name of a call expression (`bootstrapApplication`, `provideRouter`, ...). */
function calleeName(call: ts.CallExpression): string | null {
    if (ts.isIdentifier(call.expression)) return call.expression.text;
    if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
    return null;
}

/**
 * Resolve an expression to an array literal — either an inline `[...]` or an
 * identifier (`routes`) whose declaration initializes to an array literal.
 */
function asArrayLiteral(expr: ts.Expression, checker: ts.TypeChecker): ts.ArrayLiteralExpression | null {
    if (ts.isArrayLiteralExpression(expr)) return expr;
    if (ts.isIdentifier(expr)) {
        let symbol = checker.getSymbolAtLocation(expr);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
        for (const decl of symbol?.declarations ?? []) {
            if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
                return decl.initializer;
            }
        }
    }
    return null;
}

/**
 * A `loadComponent: () => import('./x').then(m => m.X)` lazy route — resolve the
 * first property access inside the arrow body that points at a class
 * declaration (the `m.X`). Returns null when the dynamic import can't be
 * followed (falls back to no root, never throws).
 */
function resolveLazyComponent(arrow: ts.Expression, checker: ts.TypeChecker): ts.ClassDeclaration | null {
    let found: ts.ClassDeclaration | null = null;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isPropertyAccessExpression(node)) {
            const cls = resolveClassDeclaration(node, checker);
            if (cls) {
                found = cls;
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(arrow);
    return found;
}

/** Parse a `Routes` array literal, collecting `component`/`loadComponent` roots (recursing `children`). */
function collectRouteComponents(
    array: ts.ArrayLiteralExpression,
    checker: ts.TypeChecker,
    out: Set<ts.ClassDeclaration>,
): void {
    for (const element of array.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        for (const prop of element.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            if (prop.name.text === 'component') {
                const cls = resolveClassDeclaration(prop.initializer, checker);
                if (cls) out.add(cls);
            } else if (prop.name.text === 'loadComponent') {
                const cls = resolveLazyComponent(prop.initializer, checker);
                if (cls) out.add(cls);
            } else if (prop.name.text === 'children') {
                const nested = asArrayLiteral(prop.initializer, checker);
                if (nested) collectRouteComponents(nested, checker, out);
            }
        }
    }
}

/**
 * Find every Angular entry component (bootstrap + routed) in the project, sorted
 * by class name for deterministic output.
 */
export function findAngularRoots(
    program: ts.Program,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    projectRoot: string,
): ts.ClassDeclaration[] {
    const roots = new Set<ts.ClassDeclaration>();

    for (const sourceFile of program.getSourceFiles()) {
        if (!isUnderProject(sourceFile, workspaceRoot, projectRoot)) continue;

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
                const name = calleeName(node);
                if (name === 'bootstrapApplication' && node.arguments[0]) {
                    const cls = resolveClassDeclaration(node.arguments[0], checker);
                    if (cls) roots.add(cls);
                } else if (name === 'provideRouter' && node.arguments[0]) {
                    const array = asArrayLiteral(node.arguments[0], checker);
                    if (array) collectRouteComponents(array, checker, roots);
                }
            } else if (
                ts.isVariableDeclaration(node) &&
                node.type &&
                ts.isTypeReferenceNode(node.type) &&
                ts.isIdentifier(node.type.typeName) &&
                node.type.typeName.text === 'Routes' &&
                node.initializer &&
                ts.isArrayLiteralExpression(node.initializer)
            ) {
                collectRouteComponents(node.initializer, checker, roots);
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return [...roots].sort((a: ts.ClassDeclaration, b: ts.ClassDeclaration) => {
        const nameA = a.name ? a.name.text : '';
        const nameB = b.name ? b.name.text : '';
        if (nameA !== nameB) return nameA < nameB ? -1 : 1;
        return a.getSourceFile().fileName < b.getSourceFile().fileName ? -1 : 1;
    });
}
