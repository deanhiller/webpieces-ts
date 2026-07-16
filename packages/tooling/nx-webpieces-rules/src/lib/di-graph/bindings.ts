/**
 * Binding Table (pass 1 of the DI graph analyzer)
 *
 * Scans every source file in the project's TypeScript program (skipping .d.ts and
 * node_modules) and collects all Inversify bindings into a Map<tokenKey, Binding[]>:
 *
 *   - ContainerModule bodies:  bind(TOKEN).to(Impl) / .toSelf() / .toConstantValue(x)
 *                              / .toDynamicValue(fn), with .inSingletonScope() etc.
 *   - Decorators:              @provideSingleton() / @provideTransient() (self-binding)
 *                              and @provideSingletonDefaultForApi(TOKEN)
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
    /** providerTokenKey -> the class its get() resolves. See bindFrameworkProvider. */
    private readonly providerTargets = new Map<string, ts.ClassDeclaration>();

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

    /** Record `bindFrameworkProvider(ProviderClass, TargetClass)`. */
    addProviderTarget(providerTokenKey: string, target: ts.ClassDeclaration): void {
        this.providerTargets.set(providerTokenKey, target);
    }

    /**
     * The class a Provider hands out, if this token is a registered Provider subclass.
     * The walker follows this so `Factory -> XProvider -> X` is visible in the design,
     * instead of the provider dead-ending as an opaque toDynamicValue leaf.
     */
    providerTarget(providerTokenKey: string): ts.ClassDeclaration | undefined {
        return this.providerTargets.get(providerTokenKey);
    }
}

function isAnalyzableFile(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile) return false;
    if (sourceFile.fileName.includes('/node_modules/')) return false;
    return true;
}

/**
 * A class the walker treats as an EXTERNAL boundary: its declaration lives in a
 * `.d.ts` file or under `node_modules` — i.e. a published package outside this
 * nx workspace. The exact inverse of {@link isAnalyzableFile}'s file test. In an
 * nx monorepo internal libs resolve through tsconfig path mappings to real `.ts`
 * source, so they are NOT external and keep expanding; only third-party packages
 * (resolved to `.d.ts` in `node_modules`) trip this. Pass-2 renders such a class
 * as a leaf `external` node and stops — it does not descend into its ctor deps.
 */
export function isExternalClass(cls: ts.ClassDeclaration): boolean {
    const sourceFile = cls.getSourceFile();
    return sourceFile.isDeclarationFile || sourceFile.fileName.includes('/node_modules/');
}

/**
 * Walk `.inSingletonScope()` / `.inTransientScope()` suffixes above a binding call.
 *
 * No scope call at all means TRANSIENT, not "unknown": that is inversify's
 * `DEFAULT_DEFAULT_SCOPE`, and no `new Container(...)` in this workspace overrides `defaultScope`.
 */
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
    return 'transient';
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
    const isApiBoundary = kind === 'toDynamicValue' && valueExpr ? isApiClientBoundary(valueExpr, checker) : false;
    table.add(new Binding(token.key, token.display, kind, scope, null, valueText, file, [], isApiBoundary));
}

/**
 * True when `expr` (the argument to `.toDynamicValue(...)` / an Angular
 * `useFactory`) builds an API-client proxy: it contains a `createApiClient(Api, ...)`
 * call whose first argument resolves to an @ApiPath-decorated contract class.
 *
 * This is the DI-graph boundary marker for generated (and external) API clients:
 * the walk renders such a binding as an `api` leaf and stops, rather than
 * descending into the client's own transport config (ClientConfig → ...).
 */
// webpieces-disable no-function-outside-class -- pure AST predicate, matching every sibling in this file
export function isApiClientBoundary(expr: ts.Expression, checker: ts.TypeChecker): boolean {
    const call = findCreateApiClientCall(expr);
    if (!call || call.arguments.length === 0) return false;
    const apiClass = resolveClassDeclaration(call.arguments[0], checker);
    return apiClass ? hasApiPathDecorator(apiClass) : false;
}

/** Find the first `createApiClient(...)` call anywhere inside `node`, else null. */
// webpieces-disable no-function-outside-class -- pure AST walker, matching every sibling in this file
function findCreateApiClientCall(node: ts.Node): ts.CallExpression | null {
    if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : null;
        if (name === 'createApiClient') return node;
    }
    let found: ts.CallExpression | null = null;
    ts.forEachChild(node, (child: ts.Node) => {
        if (!found) found = findCreateApiClientCall(child);
    });
    return found;
}

/** True when the class carries the `@ApiPath(...)` contract decorator. */
// webpieces-disable no-function-outside-class -- pure AST predicate, matching every sibling in this file
function hasApiPathDecorator(cls: ts.ClassDeclaration): boolean {
    return classDecorators(cls).some((d: ts.Decorator) => decoratorName(d) === 'ApiPath');
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

/**
 * Scope of an `@injectable(bindingScopeValues.Singleton|Transient)` SELF-binding, read from the
 * decorator ARGUMENT (either `bindingScopeValues.Singleton` or the raw 'Singleton'/'Transient'
 * string), NOT the decorator name like `@provideSingleton`.
 *
 * Returns null for a BARE `@injectable()` (no scope argument): that is NOT a self-binding — it just
 * marks a class injectable for an explicit `bind(TOKEN).to(ThatClass)` elsewhere (e.g. SimpleCounter
 * bound to a Counter token). Only `@injectable(<scope>)` with an argument opts a concrete class into
 * autobind self-binding, the inject-by-type replacement for @provideSingleton.
 */
// webpieces-disable no-function-outside-class -- pure AST predicate, matching every sibling in this file
function injectableScope(decorator: ts.Decorator): DiScope | null {
    const call = decoratorCall(decorator);
    const arg = call?.arguments[0];
    if (!arg) return null;
    const scopeName = ts.isPropertyAccessExpression(arg)
        ? arg.name.text
        : ts.isStringLiteral(arg)
          ? arg.text
          : '';
    if (scopeName === 'Singleton') return 'singleton';
    if (scopeName === 'Transient') return 'transient';
    return null;
}

function collectDecoratorBindings(
    cls: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    table: BindingTable,
): void {
    const file = relativeFile(workspaceRoot, cls.getSourceFile());
    // A provide* decorator is the explicit binding; when present it wins over a plain @injectable on
    // the same class (a transitional state where both appear). Only a class with @injectable and NO
    // provide* decorator self-binds via autobind.
    const PROVIDE_BINDERS = new Set([
        'provideSingleton',
        'provideTransient',
        'provideFrameworkSingleton',
        'provideFrameworkTransient',
        'provideSingletonDefaultForApi',
        'provideFrameworkSingletonDefaultForApi',
    ]);
    const hasProvideBinding = classDecorators(cls).some((d: ts.Decorator) => {
        const n = decoratorName(d);
        return n !== null && PROVIDE_BINDERS.has(n);
    });
    for (const decorator of classDecorators(cls)) {
        const name = decoratorName(decorator);
        // provideFrameworkSingleton(As)/Transient are the framework-registry twins of
        // provideSingleton(As)/Transient (see @webpieces/core-context frameworkProvide.ts) —
        // same self/token binding, same scopes.
        if (
            name === 'provideSingleton' ||
            name === 'provideTransient' ||
            name === 'provideFrameworkSingleton' ||
            name === 'provideFrameworkTransient'
        ) {
            const token = classTokenKey(cls, workspaceRoot);
            const transient = name === 'provideTransient' || name === 'provideFrameworkTransient';
            const scope: DiScope = transient ? 'transient' : 'singleton';
            table.add(new Binding(token.key, token.display, 'decorator', scope, cls, '', file));
        } else if (name === 'provideSingletonDefaultForApi' || name === 'provideFrameworkSingletonDefaultForApi') {
            const call = decoratorCall(decorator);
            const tokenExpr = call?.arguments[0];
            if (!tokenExpr) continue;
            const token = resolveTokenKey(tokenExpr, checker, workspaceRoot);
            table.add(new Binding(token.key, token.display, 'decorator', 'singleton', cls, '', file));
        } else if (name === 'injectable' && !hasProvideBinding) {
            // @injectable(bindingScopeValues.Singleton|Transient) self-binds the concrete class under
            // the app container's autobind (the inject-by-type replacement for @provideSingleton).
            // A bare @injectable() (scope null) is skipped — it is bound via an explicit .to(token).
            const scope = injectableScope(decorator);
            if (scope !== null) {
                const token = classTokenKey(cls, workspaceRoot);
                table.add(new Binding(token.key, token.display, 'decorator', scope, cls, '', file));
            }
        }
    }
}

/**
 * `bindFrameworkProvider(TOKEN, X)` — the Guice-style Provider registration in
 * @webpieces/core-context. Records that a `Provider<X>` injected under TOKEN yields X.
 *
 * The TOKEN is whatever names the provider (a Symbol, since `Provider<T>` is erased at runtime and
 * cannot be its own token). We never draw a node for it: a Provider is DI plumbing, not wiring.
 * The walker renders `Consumer -> X` directly, and X's OWN binding decides X's scope — and hence
 * whether the design draws one box (a lazy singleton) or a stack (a fresh instance per get()).
 */
// webpieces-disable no-function-outside-class -- ts AST visitor, matching every sibling collector in this file
function collectProviderBinding(
    call: ts.CallExpression,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    table: BindingTable,
): void {
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'bindFrameworkProvider') return;
    if (call.arguments.length < 2) return;

    // The token may be a Symbol, a class, anything — resolveTokenKey canonicalizes all of them.
    const token = resolveTokenKey(call.arguments[0], checker, workspaceRoot);
    const targetClass = resolveClassDeclaration(call.arguments[1], checker);
    if (!targetClass) return;

    table.addProviderTarget(token.key, targetClass);
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
                collectProviderBinding(node, checker, workspaceRoot, table);
            } else if (ts.isClassDeclaration(node)) {
                collectDecoratorBindings(node, checker, workspaceRoot, table);
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return table;
}
