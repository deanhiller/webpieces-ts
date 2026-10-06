import * as path from 'path';
import * as ts from 'typescript';
import { Option, RuleFailError } from '@webpieces/rules-config';
import { WiringSourceTypes, WiringKind } from './source-types';
import { CanonicalClientBindings } from './canonical-clients';

const WEBPIECES_SDK = /(?:\/packages\/(?:http|cloud)\/|\/node_modules\/@webpieces\/)(?:http-routing|http-client-node|http-client-browser|http-client-core|cloudtasks-client)\//;
const INVERSIFY = /\/node_modules\/(?:@inversifyjs\/|inversify\/)/;
/**
 * Methods that START a registration on the host's binder or router: a DI bind, a client created and
 * bound, a vendor implementation bound to its external contract, a browser provider recipe, a route
 * or a filter.
 */
const REGISTRATION_ROOTS = ['bind', 'createRpcClientAndBind', 'createPubSubClientAndBind', 'bindExternal', 'provide', 'addRoutes', 'addFilter'];
/** Removed authoring shapes; their presence means an old wrapper, helper or an anonymous module survived. */
const LEGACY_TOPOLOGY = /\b(?:rpcTarget|RpcTarget|ContainerModule|ServerWiring|ServerWiringOptions|BrowserWiring|getRuntimeWiring|RuntimeClients|RuntimeTaskClients|provideRpcClient|ExternalContractUse|BrowserBindings|BindingModule)\b/;
/** Getters renamed with BindingModule -> BindModule. */
const RENAMED_GETTERS: Readonly<Record<string, string>> = { getBindingModules: 'getBindModules', getRoutingModules: 'getRouteModules' };
/** Environment discovery belongs in prepared configuration, never in a registration argument. */
const ENVIRONMENT = new Set(['process', 'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'globalThis']);

/** The one canonical file being checked, its owner directory and where problems go. */
class CanonicalFile {
    constructor(
        readonly file: ts.SourceFile,
        readonly ownerRoot: string,
        readonly report: (node: ts.Node, message: string) => void,
    ) {}
}

/**
 * One canonical-file grammar. Each owner's src/wiring.ts holds its Wiring/AppWiring class AND the
 * BindModule/RouteModule classes it selects, with their actual registrations. A library owner's
 * canonical wiring.ts may export only BindModules. Symbol resolution may read imports; format
 * checking never does.
 */
export class WiringFormat {
    private readonly types: WiringSourceTypes;

    constructor(private readonly checker: ts.TypeChecker, private readonly maxLines: number) {
        this.types = new WiringSourceTypes(checker);
    }

    problems(file: ts.SourceFile): string[] {
        if (!/(?:^|\/)wiring\.ts$/.test(file.fileName)) return [];
        const problems: string[] = new CanonicalClientBindings(this.checker).problems(file);
        const report = (node: ts.Node, message: string): void => {
            const at = file.getLineAndCharacterOfPosition(node.getStart(file));
            problems.push(`${file.fileName}:${at.line + 1}:${at.character + 1}: ${message}`);
        };
        const scope = new CanonicalFile(file, path.dirname(path.dirname(path.resolve(file.fileName))), report);
        const lines = file.text.trimEnd().split('\n').length;
        if (lines > this.maxLines)
            report(
                file,
                `wiring.ts has ${lines} lines, above maxLines ${this.maxLines}. Keep every BindModule/RouteModule and its registrations here beside the Wiring class; shorten the file by moving configuration building, translations, environment discovery and initializer or factory bodies into imported implementations, or give a cohesive group its own library owner with its own wiring.ts.`,
            );
        for (const statement of file.statements) {
            if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
            if (!ts.isClassDeclaration(statement)) {
                report(statement, 'Only imports, exports and named declarative classes belong in wiring.ts.');
                continue;
            }
            const kind = this.types.kind(statement);
            if (kind === undefined) {
                report(statement, LEGACY_TOPOLOGY.test(statement.getText())
                    ? 'Removed authoring shape (BindingModule, ExternalContractUse, RuntimeClients, provideRpcClient, BrowserBindings); implement BindModule and register through the binder.'
                    : 'Implement the framework Wiring, AppWiring, BindModule or RouteModule contract.');
                continue;
            }
            this.classProblems(statement, kind, scope);
        }
        return problems;
    }

    assert(problems: readonly string[]): void {
        if (problems.length === 0) return;
        throw new RuleFailError('wiring-format', problems.join('\n'), undefined, undefined, [
            new Option(
                "Declare each owner's Wiring/AppWiring class together with its named BindModule/RouteModule classes and their registrations in its src/wiring.ts, selected by literal getters (getBindModules/getRouteModules/getWirings); an app may select a BindModule declared in a library owner's canonical src/wiring.ts. Register through the binder (binder.bind, binder.createRpcClientAndBind, binder.createPubSubClientAndBind, binder.bindExternal, browser binder.provide) and the router. Keep configuration building, environment discovery and initializer/factory bodies in imported implementations, and keep named WiringPolicy conditions explicit.",
                true,
            ),
        ]);
    }

    private classProblems(declaration: ts.ClassDeclaration, kind: WiringKind, scope: CanonicalFile): void {
        const report = scope.report;
        for (const member of declaration.members) {
            if (ts.isConstructorDeclaration(member)) {
                if (member.body !== undefined && member.body.statements.length > 0)
                    report(member, 'Use constructor parameter properties to store prepared inputs; no setup logic.');
                continue;
            }
            if (!ts.isMethodDeclaration(member)) {
                report(member, 'Store prepared inputs in constructor parameter properties.');
                continue;
            }
            const name = member.name.getText();
            if (Object.hasOwn(RENAMED_GETTERS, name)) {
                report(member, `${name} was renamed to ${RENAMED_GETTERS[name]}.`);
            } else if (['getBindModules', 'getRouteModules', 'getWirings'].includes(name)) {
                const expected = name === 'getWirings' ? 'wiring' : name === 'getBindModules' ? 'binding' : 'routing';
                if (name === 'getWirings' && kind !== 'app')
                    report(member, 'Only AppWiring can declare getWirings; libraries cannot compose libraries.');
                this.arrayProblems(member, expected, kind, scope);
            } else if (name === 'configure' && ['binding', 'routing'].includes(kind)) {
                for (const statement of member.body?.statements ?? []) this.configureProblems(statement, scope);
            } else if (name !== 'getHeaders' || kind !== 'app')
                report(member, 'Keep only canonical selection getters and short configure declarations; getRuntimeWiring and helper methods were removed.');
        }
        if (kind === 'binding' || kind === 'routing') {
            const configure = this.types.method(declaration, 'configure');
            if (configure !== undefined && configure.getSourceFile() !== scope.file)
                report(declaration, `configure is inherited from ${configure.getSourceFile().fileName}; declare this module's registrations in its own configure here in wiring.ts.`);
        }
        if (kind === 'app' || kind === 'wiring') {
            // getRouteModules is Node-only (its Wiring type requires it); the browser has no route channel.
            const names = ['getBindModules', 'getRouteModules', ...(kind === 'app' ? ['getWirings'] : [])];
            for (const name of names) {
                const method = this.types.method(declaration, name);
                if (method === undefined) {
                    if (name !== 'getRouteModules') report(declaration, `Missing ${name} literal array getter.`);
                } else if (method.getSourceFile() !== scope.file)
                    report(declaration, `${name} is inherited from ${method.getSourceFile().fileName}; declare the selection getter on this class in wiring.ts.`);
            }
            if (kind === 'wiring' && this.types.method(declaration, 'getWirings') !== undefined)
                report(declaration, 'A library Wiring must not inherit getWirings.');
        }
    }

    private arrayProblems(method: ts.MethodDeclaration, expected: WiringKind, ownerKind: WiringKind, scope: CanonicalFile): void {
        const report = scope.report;
        const statements = method.body?.statements;
        const returned = statements?.length === 1 && ts.isReturnStatement(statements[0]) ? statements[0].expression : undefined;
        if (returned === undefined || !ts.isArrayLiteralExpression(returned)) {
            report(method, 'Getter body must be exactly return [new NamedModule(preparedInputs)]; no delegation, spreads, helpers or conditions.');
            return;
        }
        for (const element of returned.elements) {
            if (!ts.isNewExpression(element) || this.types.kind(element.expression) !== expected) {
                report(element, `Select a named framework ${expected} instance; nested arrays and AppWiring children are forbidden.`);
                continue;
            }
            this.placementProblems(element.expression, expected, ownerKind, scope);
            for (const argument of element.arguments ?? []) {
                if (!this.prepared(argument)) report(argument, 'Pass prepared inputs or a named WiringPolicy; no callbacks, topology wrappers or computed setup.');
            }
        }
    }

    /**
     * Proven through the resolved declaration: a selected module lives in THIS file; a BindModule an
     * AppWiring selects may instead live in a library owner's canonical wiring.ts, and a library
     * Wiring always does. The extractor additionally proves that file is the owner's src/wiring.ts.
     */
    private placementProblems(selected: ts.Expression, expected: WiringKind, ownerKind: WiringKind, scope: CanonicalFile): void {
        const declared = this.types.declaration(selected)?.getSourceFile();
        const where = declared === undefined ? 'an unresolved file' : declared.fileName;
        const canonical = declared !== undefined && /(?:^|[\\/])wiring\.(?:d\.)?ts$/.test(declared.fileName);
        if (expected !== 'wiring') {
            if (declared === scope.file) return;
            if (expected === 'binding' && ownerKind === 'app' && canonical) return;
            const role = expected === 'binding' ? 'BindModule' : 'RouteModule';
            const library = expected === 'binding' && ownerKind === 'app' ? ", or in its library owner's canonical src/wiring.ts" : '';
            scope.report(selected, `${selected.getText()} is declared in ${where}; declare this ${role} class, with its registrations, here in wiring.ts beside the Wiring class that selects it${library}.`);
            return;
        }
        if (canonical) return;
        scope.report(selected, `Library Wiring ${selected.getText()} is declared in ${where}; select a Wiring declared in its library's canonical src/wiring.ts.`);
    }

    private prepared(expression: ts.Expression): boolean {
        if (ts.isIdentifier(expression) || ts.isLiteralExpression(expression)) return true;
        if (ts.isPropertyAccessExpression(expression)) return this.prepared(expression.expression);
        if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.ThisKeyword].includes(expression.kind)) return true;
        if (!ts.isNewExpression(expression)) return false;
        return this.types.isFramework(expression.expression, 'WiringPolicy');
    }

    private configureProblems(statement: ts.Statement, scope: CanonicalFile): void {
        const report = scope.report;
        if (ts.isIfStatement(statement) && ts.isPropertyAccessExpression(statement.expression) && statement.expression.name.text === 'enabled' && this.types.isPolicy(statement.expression.expression) && statement.elseStatement === undefined) {
            const body = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
            for (const child of body) this.configureProblems(child, scope);
            return;
        }
        const written = ts.isExpressionStatement(statement) || ts.isReturnStatement(statement) ? statement.expression : undefined;
        const expression = written !== undefined && ts.isAwaitExpression(written) ? written.expression : written;
        if (expression === undefined || (!ts.isCallExpression(expression) && !ts.isNewExpression(expression))) {
            report(statement, 'configure contains only registration declarations (binder DI binds, clients created and bound, external vendor bindings, provider recipes, routes, filters) and named policy conditions.');
            return;
        }
        if (LEGACY_TOPOLOGY.test(expression.getText())) {
            report(expression, 'Removed topology shape (rpcTarget, a ContainerModule, a plan wrapper, RuntimeClients/RuntimeTaskClients, provideRpcClient or ExternalContractUse); register through the binder: binder.createRpcClientAndBind(Api, deployment), binder.createPubSubClientAndBind(Api, deployment), binder.bindExternal(Api, VendorImpl) (browser: binder.bindExternal(Api, new UseClass(Vendor) | new UseExisting(Token))).');
            return;
        }
        if (!this.registration(expression, scope)) {
            report(expression, 'Use a recognized registration declaration: binder.bind(...) chains, binder.createRpcClientAndBind(Api, deployment, options?), binder.createPubSubClientAndBind(Api, deployment, options?), binder.bindExternal(Api, VendorImpl) (browser: new UseClass(Vendor) | new UseExisting(Token)), browser binder.provide(...recipes), router.addRoutes/addFilter. Move custom setup into imported implementations, and give a vendor ContainerModule its own library BindModule in that library\'s canonical wiring.ts.');
            return;
        }
        for (const argument of this.registrationArguments(expression)) {
            const offending = this.offending(argument, scope);
            if (offending !== undefined)
                report(offending, 'Pass declarative registration arguments: tokens, classes, prepared fields, literals, named factory or initializer references, provider recipe objects and calls, and short DI factory callbacks such as (ctx) => ctx.get(Token). Move computed setup, environment reads, helper calls of this owner and callback bodies into imported implementations or prepared constructor inputs.');
        }
    }

    private registration(expression: ts.CallExpression | ts.NewExpression, scope: CanonicalFile): boolean {
        if (ts.isNewExpression(expression)) return false;
        if (!ts.isPropertyAccessExpression(expression.expression)) return false;
        const name = expression.expression.name.text;
        const receiver = this.unwrap(expression.expression.expression);
        const file = this.signatureFile(expression);
        if (file === undefined) return false;
        if (!WEBPIECES_SDK.test(file) && !INVERSIFY.test(file)) return false;
        if (ts.isCallExpression(receiver)) return this.registration(receiver, scope);
        return REGISTRATION_ROOTS.includes(name) && this.path(receiver);
    }

    /** Every argument of every call in a registration chain. */
    private registrationArguments(expression: ts.CallExpression | ts.NewExpression): ts.Expression[] {
        const own = [...(expression.arguments ?? [])];
        if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return own;
        const receiver = this.unwrap(expression.expression.expression);
        if (ts.isCallExpression(receiver)) return [...own, ...this.registrationArguments(receiver)];
        return own;
    }

    /** Returns the first non-declarative node inside a registration argument, or undefined. */
    private offending(expression: ts.Expression, scope: CanonicalFile): ts.Node | undefined {
        const value = this.unwrap(expression);
        if (this.literal(value)) return undefined;
        if (ts.isIdentifier(value) || value.kind === ts.SyntaxKind.ThisKeyword || ts.isPropertyAccessExpression(value))
            return this.path(value) ? undefined : value;
        if (ts.isArrayLiteralExpression(value)) {
            for (const element of value.elements) {
                const found = this.offending(ts.isSpreadElement(element) ? element.expression : element, scope);
                if (found !== undefined) return found;
            }
            return undefined;
        }
        if (ts.isObjectLiteralExpression(value)) {
            for (const property of value.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    if (ENVIRONMENT.has(property.name.text)) return property;
                    continue;
                }
                const initializer = ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)
                    ? property.initializer : ts.isSpreadAssignment(property) ? property.expression : undefined;
                if (initializer === undefined) return property;
                const found = this.offending(initializer, scope);
                if (found !== undefined) return found;
            }
            return undefined;
        }
        if (ts.isNewExpression(value)) {
            if (!this.path(value.expression) || LEGACY_TOPOLOGY.test(value.expression.getText())) return value;
            return this.firstOffending(value.arguments ?? [], scope);
        }
        if (ts.isCallExpression(value)) {
            const callee = value.expression;
            const receiverOk = this.path(callee) ||
                (ts.isPropertyAccessExpression(callee) && ts.isNewExpression(callee.expression) && this.offending(callee.expression, scope) === undefined);
            if (!receiverOk || !this.outsideOwner(value, scope)) return value;
            return this.firstOffending(value.arguments, scope);
        }
        if (ts.isArrowFunction(value)) return this.factoryCallback(value) ? undefined : value;
        return value;
    }

    private firstOffending(values: readonly ts.Expression[], scope: CanonicalFile): ts.Node | undefined {
        for (const value of values) {
            const found = this.offending(value, scope);
            if (found !== undefined) return found;
        }
        return undefined;
    }

    /**
     * A provider recipe or vendor factory (Angular, webpieces, another library) is a declaration; a
     * call into this owner's own helpers would hide the registrations it returns.
     */
    private outsideOwner(call: ts.CallExpression, scope: CanonicalFile): boolean {
        const file = this.signatureFile(call);
        if (file === undefined) return false;
        return file.includes('/node_modules/') || !file.startsWith(scope.ownerRoot.replace(/\\/g, '/') + '/');
    }

    /** A short DI factory: `(ctx) => ctx.get(Token)`, `(dep) => dep.build()` or `(dep) => new Named(dep)`. */
    private factoryCallback(arrow: ts.ArrowFunction): boolean {
        if (ts.isBlock(arrow.body)) return false;
        const parameters = new Set(arrow.parameters.map((parameter: ts.ParameterDeclaration) => parameter.name.getText()));
        const body = this.unwrap(arrow.body);
        const simple = (argument: ts.Expression): boolean => this.literal(this.unwrap(argument)) || this.path(this.unwrap(argument));
        if (ts.isNewExpression(body)) return this.path(body.expression) && (body.arguments ?? []).every(simple);
        if (!ts.isCallExpression(body) || !ts.isPropertyAccessExpression(body.expression)) return false;
        const receiver = body.expression.expression;
        return ts.isIdentifier(receiver) && parameters.has(receiver.text) && body.arguments.every(simple);
    }

    /** An identifier, `this`, or a property path over them that does not read the environment. */
    private path(expression: ts.Expression): boolean {
        if (ts.isIdentifier(expression)) return !ENVIRONMENT.has(expression.text);
        if (expression.kind === ts.SyntaxKind.ThisKeyword) return true;
        return ts.isPropertyAccessExpression(expression) && this.path(expression.expression);
    }

    private literal(expression: ts.Expression): boolean {
        if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return true;
        if (ts.isPrefixUnaryExpression(expression)) return ts.isNumericLiteral(expression.operand);
        return [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expression.kind) ||
            (ts.isIdentifier(expression) && expression.text === 'undefined');
    }

    private unwrap(expression: ts.Expression): ts.Expression {
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression))
            return this.unwrap(expression.expression);
        return expression;
    }

    private signatureFile(call: ts.CallExpression): string | undefined {
        const declaration = this.checker.getResolvedSignature(call)?.declaration;
        return declaration === undefined ? undefined : path.resolve(declaration.getSourceFile().fileName).replace(/\\/g, '/');
    }
}
