/**
 * Angular Provider Table (pass 1, Angular flavor)
 *
 * The Angular analog of `bindings.ts` (Inversify): scans the program and maps
 * Angular's provider forms onto the SAME token-keyed {@link BindingTable} the
 * shared walker consumes, so `angular-analyzer.ts` reuses every downstream
 * mechanism (leaf labeling, factory-dep edges, unresolved handling).
 *
 * Provider sources (v1 flat global table — component-scoped shadowing is an
 * accepted approximation):
 *   - Any `providers: [...]` array (ApplicationConfig, `@Component`, `@Directive`)
 *   - `@Injectable({ providedIn: 'root' | 'platform' | 'any' })` self-registration
 *
 * Provider forms per array element:
 *   - bare class `Foo`                         → to/self binding (implClass=Foo)
 *   - `{ provide, useClass }`                  → to binding (implClass)
 *   - `{ provide, useValue }`                  → toConstantValue leaf
 *   - `{ provide, useFactory, deps: [A, B] }`  → toDynamicValue leaf + factoryDeps
 *   - `{ provide, useExisting }`               → alias → target impl class
 *   - `multi: true`                            → multiple bindings per token (fan-out)
 *
 * Framework-internal `provideXxx()` calls (`provideRouter`,
 * `provideZoneChangeDetection`, ...) have no DI leaves and are skipped.
 */

import * as ts from 'typescript';
import { Binding, DiScope, TokenRef } from './model';
import { BindingTable, classDecorators, decoratorCall, decoratorName, resolveClassDeclaration } from './bindings';
import { classTokenKey, relativeFile, resolveTokenKey } from './token-resolver';

// Angular injector-scoped providers are effectively singletons at their scope.
const ANGULAR_SCOPE: DiScope = 'singleton';

function isAnalyzableFile(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile) return false;
    if (sourceFile.fileName.includes('/node_modules/')) return false;
    return true;
}

/** First line of an expression's source text, truncated for leaf labels. */
function firstLine(text: string): string {
    const line = text.split('\n')[0].trim();
    return line.length > 60 ? line.slice(0, 57) + '...' : line;
}

/** Pull `{ name: value }` properties out of an object literal into a map. */
function objectProps(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
    const props = new Map<string, ts.Expression>();
    for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))) {
            props.set(prop.name.text, prop.initializer);
        }
    }
    return props;
}

/** Resolve each `deps: [A, B]` element to a token reference for factory-dep edges. */
function collectDeps(depsExpr: ts.Expression | undefined, checker: ts.TypeChecker, workspaceRoot: string): TokenRef[] {
    if (!depsExpr || !ts.isArrayLiteralExpression(depsExpr)) return [];
    const deps: TokenRef[] = [];
    for (const element of depsExpr.elements) {
        // Simple token form (`EnvironmentConfig`); the decorated array form
        // (`[new Optional(), Token]`) is out of scope for v1.
        if (ts.isIdentifier(element) || ts.isPropertyAccessExpression(element)) {
            const cls = resolveClassDeclaration(element, checker);
            deps.push(cls ? classTokenKey(cls, workspaceRoot) : resolveTokenKey(element, checker, workspaceRoot));
        }
    }
    return deps;
}

/** Record one provider-object literal (`{ provide, useX }`) as a binding. */
function collectProviderObject(
    obj: ts.ObjectLiteralExpression,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    file: string,
    table: BindingTable,
): void {
    const props = objectProps(obj);
    const provideExpr = props.get('provide');
    if (!provideExpr) return;

    const provideClass = resolveClassDeclaration(provideExpr, checker);
    const token = provideClass
        ? classTokenKey(provideClass, workspaceRoot)
        : resolveTokenKey(provideExpr, checker, workspaceRoot);

    const useClass = props.get('useClass');
    const useValue = props.get('useValue');
    const useFactory = props.get('useFactory');
    const useExisting = props.get('useExisting');

    if (useClass) {
        const impl = resolveClassDeclaration(useClass, checker);
        table.add(new Binding(token.key, token.display, 'to', ANGULAR_SCOPE, impl, useClass.getText(), file));
        return;
    }
    if (useExisting) {
        // Alias: T resolves to whatever `useExisting` points at — resolve through
        // to the target impl class so the walk continues into its dependencies.
        const impl = resolveClassDeclaration(useExisting, checker);
        table.add(new Binding(token.key, token.display, 'to', ANGULAR_SCOPE, impl, useExisting.getText(), file));
        return;
    }
    if (useFactory) {
        const deps = collectDeps(props.get('deps'), checker, workspaceRoot);
        table.add(
            new Binding(token.key, token.display, 'toDynamicValue', ANGULAR_SCOPE, null, firstLine(useFactory.getText()), file, deps),
        );
        return;
    }
    if (useValue) {
        table.add(
            new Binding(token.key, token.display, 'toConstantValue', ANGULAR_SCOPE, null, firstLine(useValue.getText()), file),
        );
        return;
    }
    // `{ provide: T }` with no recipe — treat the token itself as the impl class.
    if (provideClass) {
        table.add(new Binding(token.key, token.display, 'to', ANGULAR_SCOPE, provideClass, provideExpr.getText(), file));
    }
}

/** Record one element of a `providers: [...]` array. */
function collectProviderElement(
    element: ts.Expression,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    file: string,
    table: BindingTable,
): void {
    // Framework-internal `provideRouter(...)` / `provideZoneChangeDetection(...)`.
    if (ts.isCallExpression(element)) return;

    // Bare class provider: `providers: [MyService]` → useClass: MyService.
    if (ts.isIdentifier(element) || ts.isPropertyAccessExpression(element)) {
        const cls = resolveClassDeclaration(element, checker);
        if (cls) {
            const token = classTokenKey(cls, workspaceRoot);
            table.add(new Binding(token.key, token.display, 'to', ANGULAR_SCOPE, cls, element.getText(), file));
        }
        return;
    }

    if (ts.isObjectLiteralExpression(element)) {
        collectProviderObject(element, checker, workspaceRoot, file, table);
    }
}

/** `@Injectable({ providedIn: 'root' | 'platform' | 'any' })` self-registration. */
function collectInjectableSelfBinding(
    cls: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    workspaceRoot: string,
    table: BindingTable,
): void {
    for (const decorator of classDecorators(cls)) {
        if (decoratorName(decorator) !== 'Injectable') continue;
        const call = decoratorCall(decorator);
        const arg = call?.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) return;
        const providedIn = objectProps(arg).get('providedIn');
        if (providedIn && ts.isStringLiteralLike(providedIn)) {
            const token = classTokenKey(cls, workspaceRoot);
            const file = relativeFile(workspaceRoot, cls.getSourceFile());
            table.add(new Binding(token.key, token.display, 'decorator', ANGULAR_SCOPE, cls, '', file));
        }
        return;
    }
}

/**
 * Collect every Angular provider in the program into a token-keyed table.
 * `checker` is required so cross-package class tokens (`SaveApi`, `ClientConfig`)
 * resolve to the same declaration the injection sites reference.
 */
export function collectAngularProviders(
    program: ts.Program,
    checker: ts.TypeChecker,
    workspaceRoot: string,
): BindingTable {
    const table = new BindingTable();

    for (const sourceFile of program.getSourceFiles()) {
        if (!isAnalyzableFile(sourceFile)) continue;
        const file = relativeFile(workspaceRoot, sourceFile);

        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node)) {
                collectInjectableSelfBinding(node, checker, workspaceRoot, table);
            } else if (
                ts.isPropertyAssignment(node) &&
                (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
                node.name.text === 'providers' &&
                ts.isArrayLiteralExpression(node.initializer)
            ) {
                for (const element of node.initializer.elements) {
                    collectProviderElement(element, checker, workspaceRoot, file, table);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return table;
}
