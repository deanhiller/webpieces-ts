/**
 * Binding Table (pass 1 of the DI graph analyzer)
 *
 * Scans every source file in the project's TypeScript program (skipping .d.ts and
 * node_modules) and collects all Inversify bindings into a Map<tokenKey, Binding[]>:
 *
 *   - ContainerModule bodies:  bind(TOKEN).to(Impl) / .toSelf() / .toConstantValue(x)
 *                              / .toDynamicValue(fn), with .inSingletonScope() etc.
 *   - Decorators:              @provideSingleton() / @provideTransient() (self-binding)
 *                              and @provideSingletonAs(TOKEN)
 *
 * Arrays because multiInject tokens (e.g. HEADER_TYPES.PlatformHeadersExtension) are
 * bound once per ContainerModule across several packages.
 */

import * as ts from 'typescript';
import { Binding, BindingKind, DiScope } from './model';
import { classTokenKey, relativeFile, resolveTokenKey } from './token-resolver';

const BIND_METHOD_NAMES = new Set(['to', 'toSelf', 'toConstantValue', 'toDynamicValue']);

export class BindingTable {
    private readonly byToken = new Map<string, Binding[]>();

    add(binding: Binding): void {
        const list = this.byToken.get(binding.tokenKey);
        if (list) {
            list.push(binding);
        } else {
            this.byToken.set(binding.tokenKey, [binding]);
        }
    }

    lookup(tokenKey: string): Binding[] {
        return this.byToken.get(tokenKey) ?? [];
    }
}

function isAnalyzableFile(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile) return false;
    if (sourceFile.fileName.includes('/node_modules/')) return false;
    return true;
}

/** Walk `.inSingletonScope()` / `.inTransientScope()` suffixes above a binding call. */
function scopeFromChain(bindingCall: ts.CallExpression): DiScope {
    let node: ts.Node = bindingCall;
    while (
        node.parent &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.parent &&
        ts.isCallExpression(node.parent.parent)
    ) {
        const methodName = node.parent.name.text;
        if (methodName === 'inSingletonScope') return 'singleton';
        if (methodName === 'inTransientScope') return 'transient';
        node = node.parent.parent;
    }
    return 'unknown';
}

/**
 * If `expr` is (or resolves through the checker to) a class declaration, return it.
 */
export function resolveClassDeclaration(
    expr: ts.Expression,
    checker: ts.TypeChecker,
): ts.ClassDeclaration | null {
    let symbol = checker.getSymbolAtLocation(expr);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
    }
    for (const decl of symbol?.declarations ?? []) {
        if (ts.isClassDeclaration(decl)) return decl;
    }
    return null;
}

/**
 * Recognize `bind(TOKEN)` at the bottom of a fluent chain. Accepts a bare `bind(...)`
 * identifier call or `options.bind(...)` property call.
 */
function asBindCall(expr: ts.Expression): ts.CallExpression | null {
    if (!ts.isCallExpression(expr)) return null;
    const callee = expr.expression;
    if (ts.isIdentifier(callee) && callee.text === 'bind') return expr;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return expr;
    return null;
}

/**
 * Handle one `<receiver>.to*(...)` call: if the receiver bottoms out at bind(TOKEN),
 * record the binding.
 */
function collectBindCall(
    call: ts.CallExpression,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    table: BindingTable,
): void {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    const methodName = call.expression.name.text;
    if (!BIND_METHOD_NAMES.has(methodName)) return;

    const bindCall = asBindCall(call.expression.expression);
    if (!bindCall || bindCall.arguments.length === 0) return;

    const tokenExpr = bindCall.arguments[0];
    const file = relativeFile(workspaceRoot, call.getSourceFile());
    const scope = scopeFromChain(call);

    if (methodName === 'toSelf') {
        const cls = resolveClassDeclaration(tokenExpr, checker);
        const token = cls
            ? classTokenKey(cls, workspaceRoot)
            : resolveTokenKey(tokenExpr, checker, workspaceRoot);
        table.add(new Binding(token.key, tokenExpr.getText(), 'toSelf', scope, cls, '', file));
        return;
    }

    const token = resolveTokenKey(tokenExpr, checker, workspaceRoot);

    if (methodName === 'to') {
        const implExpr = call.arguments[0];
        const cls = implExpr ? resolveClassDeclaration(implExpr, checker) : null;
        const valueText = implExpr ? implExpr.getText() : '';
        table.add(new Binding(token.key, token.display, 'to', scope, cls, valueText, file));
        return;
    }

    const kind: BindingKind = methodName === 'toConstantValue' ? 'toConstantValue' : 'toDynamicValue';
    const valueExpr = call.arguments[0];
    const valueText = valueExpr ? firstLine(valueExpr.getText()) : '';
    table.add(new Binding(token.key, token.display, kind, scope, null, valueText, file));
}

function firstLine(text: string): string {
    const line = text.split('\n')[0].trim();
    return line.length > 60 ? line.slice(0, 57) + '...' : line;
}

/** Return the decorator call expression when `decorator` is `@name(...)`, else null. */
export function decoratorCall(decorator: ts.Decorator): ts.CallExpression | null {
    return ts.isCallExpression(decorator.expression) ? decorator.expression : null;
}

/** The identifier name of a decorator like `@provideSingleton()` or `@inject(X)`. */
export function decoratorName(decorator: ts.Decorator): string | null {
    const call = decoratorCall(decorator);
    const callee = call ? call.expression : decorator.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return null;
}

export function classDecorators(cls: ts.ClassDeclaration): ts.Decorator[] {
    const decorators = ts.getDecorators(cls);
    return decorators ? [...decorators] : [];
}

function collectDecoratorBindings(
    cls: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    table: BindingTable,
): void {
    const file = relativeFile(workspaceRoot, cls.getSourceFile());
    for (const decorator of classDecorators(cls)) {
        const name = decoratorName(decorator);
        if (name === 'provideSingleton' || name === 'provideTransient') {
            const token = classTokenKey(cls, workspaceRoot);
            const scope: DiScope = name === 'provideSingleton' ? 'singleton' : 'transient';
            table.add(new Binding(token.key, token.display, 'decorator', scope, cls, '', file));
        } else if (name === 'provideSingletonAs') {
            const call = decoratorCall(decorator);
            const tokenExpr = call?.arguments[0];
            if (!tokenExpr) continue;
            const token = resolveTokenKey(tokenExpr, checker, workspaceRoot);
            table.add(new Binding(token.key, token.display, 'decorator', 'singleton', cls, '', file));
        }
    }
}

/**
 * Pass 1: collect every binding in the program into a token-keyed table.
 */
export function collectBindings(
    program: ts.Program,
    checker: ts.TypeChecker,
    workspaceRoot: string,
): BindingTable {
    const table = new BindingTable();

    for (const sourceFile of program.getSourceFiles()) {
        if (!isAnalyzableFile(sourceFile)) continue;

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
                collectBindCall(node, checker, workspaceRoot, table);
            } else if (ts.isClassDeclaration(node)) {
                collectDecoratorBindings(node, checker, workspaceRoot, table);
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return table;
}
