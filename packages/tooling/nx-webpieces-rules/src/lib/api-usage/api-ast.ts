/** Parser-only API contract AST accessors; deliberately avoids module resolution and erased d.ts. */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { classDecorators, decoratorName } from '../di-graph/bindings';
import {
    ApiClassInfo,
    ApiMethodMeta,
    ApiParameterMeta,
    ContractHttpMethod,
    ApiTransport,
    EmptiedApiContract,
    EndpointKind,
    EndpointOperation,
    ExternalSystemDeclaration,
    isExternalSystemKind,
    NonLiteralDecoratorArg,
    UndeclaredExternalCaller,
    UndeclaredEndpointOperation,
    UnresolvedEndpointPath,
} from './api-relations';

/** Legal enum-backed `@Endpoint` symbols; tooling reads source without importing application code. */
const ENDPOINT_KINDS: readonly EndpointKind[] = ['rpc', 'cloudtasks', 'cron', 'external'];
const ENDPOINT_OPERATIONS: readonly EndpointOperation[] = ['read', 'write-idempotent', 'write'];
const ENDPOINT_SYMBOLS: Readonly<Record<string, string>> = {
    GET: 'GET',
    POST: 'POST',
    READ: 'read',
    WRITE_IDEMPOTENT: 'write-idempotent',
    WRITE: 'write',
    RPC: 'rpc',
    CLOUDTASKS: 'cloudtasks',
    CRON: 'cron',
    EXTERNAL: 'external',
};

/**
 * Name suffix that marks an exported type in an `externalApiPaths` project as a vendor CONTRACT
 * (`GmailApi`, `StorageApi`) rather than one of the DTOs, configs or clients sitting beside it.
 * The same convention the in-repo contracts already follow, applied where no decorator can be read.
 */
const EXTERNAL_CONTRACT_SUFFIX = 'Api';

/** JSDoc tag a vendor contract uses to declare WHAT it is a seam to: `@externalSystem database Firestore`. */
const EXTERNAL_SYSTEM_TAG = 'externalSystem';

/**
 * Client-config class-name suffix whose FIRST constructor argument is the target service name —
 * `ClientConfig('helper-fsdb')` (rpc) and `TaskClientConfig('helper-fsdb')` (pubsub) both take
 * `svcName` first, and a consumer's own `XxxClientConfig` follows the same shape.
 */
const CLIENT_CONFIG_SUFFIX = 'ClientConfig';

/** Same-module string constants that parser-only decorator scanning can safely resolve. */
export class ModuleStringConstants {
    constructor(private readonly byName: Map<string, string>) {}

    lookup(name: string): string | null {
        return this.byName.get(name) ?? null;
    }
}

/** Parsed constants per source file — every class in a file shares one table. */
const CONSTANTS_BY_FILE = new WeakMap<ts.SourceFile, ModuleStringConstants>();

/** The module-scope string constants of `sourceFile`, parsed once per file. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function stringConstantsOf(sourceFile: ts.SourceFile): ModuleStringConstants {
    const cached = CONSTANTS_BY_FILE.get(sourceFile);
    if (cached !== undefined) return cached;
    const byName = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)) continue;
            const text = stringValueOf(declaration.initializer);
            if (text !== null) byName.set(declaration.name.text, text);
        }
    }
    const constants = new ModuleStringConstants(byName);
    CONSTANTS_BY_FILE.set(sourceFile, constants);
    return constants;
}

/** The string an initializer denotes, unwrapping `as const` / parentheses, else null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function stringValueOf(expr: ts.Expression | undefined): string | null {
    if (expr === undefined) return null;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr))
        return stringValueOf(expr.expression);
    return null;
}

/** A resolved decorator string, or the source spelling that could not be reduced. */
export class DecoratorArgValue {
    constructor(
        public readonly value: string | null,
        public readonly unresolvedName: string | null,
    ) {}
}

/** Read one decorator argument as a string, resolving same-module constants. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function decoratorArgValue(
    expr: ts.Expression | undefined,
    constants: ModuleStringConstants,
): DecoratorArgValue {
    if (expr === undefined) return new DecoratorArgValue(null, null);
    const literal = stringValueOf(expr);
    if (literal !== null) return new DecoratorArgValue(literal, null);
    if (ts.isIdentifier(expr)) {
        const resolved = constants.lookup(expr.text);
        if (resolved !== null) return new DecoratorArgValue(resolved, null);
        return new DecoratorArgValue(null, expr.text);
    }
    return new DecoratorArgValue(null, expr.getText());
}

/** Resolve the enum-backed constants intentionally allowed in @Endpoint positional arguments. */
// webpieces-disable no-function-outside-class -- pure AST accessor for decorator source
function endpointSymbolArgValue(
    expr: ts.Expression | undefined,
    constants: ModuleStringConstants,
): DecoratorArgValue {
    if (expr && ts.isIdentifier(expr)) {
        const builtin = ENDPOINT_SYMBOLS[expr.text];
        if (builtin !== undefined) return new DecoratorArgValue(builtin, null);
    }
    return decoratorArgValue(expr, constants);
}

/** Aggregates parser-only scan losses so generation can fail loudly instead of dropping routes. */
export class DecoratorArgDiagnostics {
    private readonly found: NonLiteralDecoratorArg[] = [];
    private readonly unresolvedPaths: UnresolvedEndpointPath[] = [];
    private readonly emptied: EmptiedApiContract[] = [];
    private readonly undeclaredCallers: UndeclaredExternalCaller[] = [];
    private readonly undeclaredOperations: UndeclaredEndpointOperation[] = [];

    constructor(private readonly workspaceRoot: string) {}

    /** Record `argument` (as written) as unresolvable at `node`'s location. */
    record(
        api: string,
        decorator: string,
        method: string | null,
        argument: string,
        node: ts.Node,
    ): void {
        this.found.push(
            new NonLiteralDecoratorArg(api, decorator, method, argument, this.locate(node)),
        );
    }

    /** Record an `@Endpoint` whose path argument is unreadable — fatal, see UnresolvedEndpointPathError. */
    recordUnresolvedPath(api: string, method: string, argument: string, node: ts.Node): void {
        this.unresolvedPaths.push(
            new UnresolvedEndpointPath(api, method, argument, this.locate(node)),
        );
    }

    /** Record a class that declared `declared` `@Endpoint` methods and kept none of them. */
    recordEmptiedContract(api: string, declared: number, node: ts.Node): void {
        this.emptied.push(new EmptiedApiContract(api, declared, this.locate(node)));
    }

    /** Record an `external` `@Endpoint` whose caller is unreadable — fatal, see UndeclaredExternalCallerError. */
    recordUndeclaredCaller(api: string, method: string, argument: string, node: ts.Node): void {
        this.undeclaredCallers.push(
            new UndeclaredExternalCaller(api, method, argument, this.locate(node)),
        );
    }

    /** Record an `@Endpoint` whose required operation is missing or unreadable. */
    recordUndeclaredOperation(api: string, method: string, argument: string, node: ts.Node): void {
        this.undeclaredOperations.push(
            new UndeclaredEndpointOperation(api, method, argument, this.locate(node)),
        );
    }

    all(): NonLiteralDecoratorArg[] {
        return this.found;
    }

    unresolvedEndpointPaths(): UnresolvedEndpointPath[] {
        return this.unresolvedPaths;
    }

    emptiedContracts(): EmptiedApiContract[] {
        return this.emptied;
    }

    undeclaredExternalCallers(): UndeclaredExternalCaller[] {
        return this.undeclaredCallers;
    }

    undeclaredEndpointOperations(): UndeclaredEndpointOperation[] {
        return this.undeclaredOperations;
    }

    private locate(node: ts.Node): string {
        const sourceFile = node.getSourceFile();
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        return `${path.relative(this.workspaceRoot, sourceFile.fileName)}:${position.line + 1}`;
    }
}

/** {api, owner: `project`, type} when `cls` is an `abstract class` carrying `@ApiPath`, else null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function apiClassInfoFrom(
    cls: ts.ClassDeclaration,
    project: string,
    diagnostics: DecoratorArgDiagnostics | null = null,
): ApiClassInfo | null {
    if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return null;
    const api = cls.name.text;
    const constants = stringConstantsOf(cls.getSourceFile());
    const info: ApiClassInfo = {
        api,
        owner: project,
        type: apiTransport(cls),
        methods: endpointMethodsOf(cls, api, constants, diagnostics),
    };
    const basePath = decoratorStringArg(cls, 'ApiPath', constants, diagnostics, api);
    if (basePath !== null) info.basePath = basePath;
    return info;
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
export function apiTransport(cls: ts.ClassDeclaration): ApiTransport {
    return hasClassDecorator(cls, 'PubSub') ? 'pubsub' : 'rpc';
}

/** The @Endpoint kinds that are actually DELIVERED through a named queue or schedule. */
const QUEUED_KINDS: readonly EndpointKind[] = ['cloudtasks', 'cron'];

/** Reads required `(method, path, operation, kind, options?)` endpoint declarations in order. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function endpointMethodsOf(
    cls: ts.ClassDeclaration,
    api: string,
    constants: ModuleStringConstants = new ModuleStringConstants(new Map<string, string>()),
    diagnostics: DecoratorArgDiagnostics | null = null,
): ApiMethodMeta[] {
    const methods: ApiMethodMeta[] = [];
    let declared = 0;
    for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const endpoint = memberDecorator(member, 'Endpoint');
        if (endpoint === null) continue;
        declared++;
        const name = member.name.text;
        const args = decoratorArgs(endpoint);
        const methodArg = endpointSymbolArgValue(args[0], constants);
        const pathArg = decoratorArgValue(args[1], constants);
        const operationArg = endpointSymbolArgValue(args[2], constants);
        const kindArg = endpointSymbolArgValue(args[3], constants);
        reportUnresolved(diagnostics, api, 'Endpoint', name, methodArg, endpoint);
        reportUnresolved(diagnostics, api, 'Endpoint', name, pathArg, endpoint);
        reportUnresolved(diagnostics, api, 'Endpoint', name, operationArg, endpoint);
        reportUnresolved(diagnostics, api, 'Endpoint', name, kindArg, endpoint);
        if (diagnostics !== null && pathArg.unresolvedName !== null) {
            diagnostics.recordUnresolvedPath(api, name, pathArg.unresolvedName, endpoint);
        }
        const httpMethod = methodArg.value;
        const operation = endpointOperationOf(args[2], constants, diagnostics, api, name, endpoint);
        const kind = kindArg.value;
        if (
            (httpMethod !== 'GET' && httpMethod !== 'POST') ||
            pathArg.value === null ||
            operation === null ||
            kind === null ||
            !ENDPOINT_KINDS.includes(kind as EndpointKind)
        )
            continue;
        const method: ApiMethodMeta = {
            name,
            path: pathArg.value,
            kind: kind as EndpointKind,
            operation,
            httpMethod,
        };
        const parameters = httpParametersOf(member, httpMethod, constants, diagnostics, api, name);
        if (parameters.length > 0) method.parameters = parameters;
        if (endpointResponseTypeOf(args[4], constants) === 'full') method.responseType = 'full';
        if (QUEUED_KINDS.includes(method.kind)) {
            method.queueName = queueNameOf(member, api, name, constants, diagnostics);
        }
        if (method.kind === 'external') {
            const caller = externalCallerOf(args[4], constants);
            if (caller.declaration !== null) method.caller = caller.declaration;
            else if (diagnostics !== null)
                diagnostics.recordUndeclaredCaller(api, name, caller.problem!, endpoint);
        }
        methods.push(method);
    }
    if (diagnostics !== null && declared > 0 && methods.length === 0) {
        diagnostics.recordEmptiedContract(api, declared, cls);
    }
    return methods;
}

/** Required side-effect declaration; no inference from GET/POST is permitted. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers
export function endpointOperationOf(
    operationArgument: ts.Expression | undefined,
    constants: ModuleStringConstants,
    diagnostics: DecoratorArgDiagnostics | null,
    api: string,
    method: string,
    node: ts.Node,
): EndpointOperation | null {
    const declared = endpointSymbolArgValue(operationArgument, constants);
    if (declared.value === null) {
        diagnostics?.recordUndeclaredOperation(
            api,
            method,
            declared.unresolvedName ?? '<missing>',
            node,
        );
        return null;
    }
    reportUnresolved(diagnostics, api, 'Endpoint.operation', method, declared, node);
    if (
        declared.value !== null &&
        ENDPOINT_OPERATIONS.includes(declared.value as EndpointOperation)
    ) {
        return declared.value as EndpointOperation;
    }
    diagnostics?.recordUndeclaredOperation(
        api,
        method,
        declared.unresolvedName ?? declared.value ?? '<missing>',
        node,
    );
    return null;
}

/** Required first positional HTTP method. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers
export function httpMethodOf(
    methodArgument: ts.Expression | undefined,
    constants: ModuleStringConstants,
    diagnostics: DecoratorArgDiagnostics | null,
    api: string,
    method: string,
    node: ts.Node,
): ContractHttpMethod | null {
    const declared = endpointSymbolArgValue(methodArgument, constants);
    reportUnresolved(diagnostics, api, 'Endpoint.httpMethod', method, declared, node);
    if (declared.value === 'GET' || declared.value === 'POST') return declared.value;
    return null;
}

/** Only the non-default full-response marker needs an architecture field. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers
export function endpointResponseTypeOf(
    options: ts.Expression | undefined,
    constants: ModuleStringConstants,
): 'body' | 'full' {
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return 'body';
    return objectPropertyValue(options, 'responseType', constants).value === 'full'
        ? 'full'
        : 'body';
}

/** Explicit `@PathParam` / `@QueryParam` mappings in source declaration order. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers
export function httpParametersOf(
    member: ts.MethodDeclaration,
    httpMethod: ContractHttpMethod,
    constants: ModuleStringConstants,
    diagnostics: DecoratorArgDiagnostics | null,
    api: string,
    method: string,
): ApiParameterMeta[] {
    const parameters: ApiParameterMeta[] = [];
    member.parameters.forEach((parameter: ts.ParameterDeclaration, index: number) => {
        let mapped = false;
        for (const source of ['path', 'query'] as const) {
            const decoratorNameWanted = source === 'path' ? 'PathParam' : 'QueryParam';
            const decorator = decoratorOn(parameter, decoratorNameWanted);
            if (decorator === null) continue;
            mapped = true;
            const wireName = decoratorArgValue(decoratorArgs(decorator)[0], constants);
            reportUnresolved(diagnostics, api, decoratorNameWanted, method, wireName, decorator);
            if (wireName.value !== null) {
                parameters.push({ index, source, wireName: wireName.value });
            }
        }
        if (!mapped && httpMethod === 'POST') parameters.push({ index, source: 'body' });
    });
    return parameters;
}

/** Default `callerKind` when an `external` endpoint declares `calledBy` alone — mirrors core-util. */
const DEFAULT_CALLER_KIND = 'saas';

/** Resolved EXTERNAL caller declaration, or the source problem that prevented resolution. */
export class ExternalCallerRead {
    constructor(
        public readonly declaration: ExternalSystemDeclaration | null,
        /** What was wrong, as written, for the diagnostic. Null exactly when `declaration` is set. */
        public readonly problem: string | null,
    ) {}
}

/** Reads `calledBy` and optional `callerKind` from the fifth positional options argument. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function externalCallerOf(
    arg: ts.Expression | undefined,
    constants: ModuleStringConstants,
): ExternalCallerRead {
    if (arg === undefined) return new ExternalCallerRead(null, '<no options argument>');
    if (!ts.isObjectLiteralExpression(arg)) return new ExternalCallerRead(null, arg.getText());
    const calledBy = objectPropertyValue(arg, 'calledBy', constants);
    if (calledBy.value === null || calledBy.value === '') {
        return new ExternalCallerRead(null, calledBy.unresolvedName ?? '<no calledBy>');
    }
    const callerKind = objectPropertyValue(arg, 'callerKind', constants);
    if (callerKind.value === null && callerKind.unresolvedName !== null) {
        return new ExternalCallerRead(null, `callerKind: ${callerKind.unresolvedName}`);
    }
    const kind = callerKind.value ?? DEFAULT_CALLER_KIND;
    if (!isExternalSystemKind(kind)) return new ExternalCallerRead(null, `callerKind: '${kind}'`);
    return new ExternalCallerRead({ kind, label: calledBy.value }, null);
}

/** One property of an object literal, read as a string through the same constant folding as an argument. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function objectPropertyValue(
    literal: ts.ObjectLiteralExpression,
    name: string,
    constants: ModuleStringConstants,
): DecoratorArgValue {
    for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) || property.name === undefined) continue;
        const key =
            ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
                ? property.name.text
                : null;
        if (key !== name) continue;
        return decoratorArgValue(property.initializer, constants);
    }
    return new DecoratorArgValue(null, null);
}

/** `@Queue('...')` override when present and resolvable, else the derived `${Api}-${method}`. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function queueNameOf(
    member: ts.MethodDeclaration,
    api: string,
    name: string,
    constants: ModuleStringConstants,
    diagnostics: DecoratorArgDiagnostics | null,
): string {
    const override = memberDecorator(member, 'Queue');
    if (override === null) return `${api}-${name}`;
    const queueArg = decoratorArgValue(decoratorArgs(override)[0], constants);
    reportUnresolved(diagnostics, api, 'Queue', name, queueArg, override);
    return queueArg.value ?? `${api}-${name}`;
}

/** Record an argument that is present but unresolvable; a resolved or absent one is silent. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function reportUnresolved(
    diagnostics: DecoratorArgDiagnostics | null,
    api: string,
    decorator: string,
    method: string | null,
    arg: DecoratorArgValue,
    node: ts.Node,
): void {
    if (diagnostics === null || arg.unresolvedName === null) return;
    diagnostics.record(api, decorator, method, arg.unresolvedName, node);
}

/** The arguments of a decorator's call expression, or [] when it is a bare `@Foo` reference. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function decoratorArgs(
    decorator: ts.Decorator,
): ts.NodeArray<ts.Expression> | ts.Expression[] {
    return ts.isCallExpression(decorator.expression) ? decorator.expression.arguments : [];
}

/** The named decorator on a class member, or null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function memberDecorator(member: ts.ClassElement, name: string): ts.Decorator | null {
    const decorators = ts.getDecorators(member as ts.HasDecorators) ?? [];
    return decorators.find((d: ts.Decorator) => decoratorName(d) === name) ?? null;
}

/** The named decorator on any decorator-capable AST node (notably a method parameter). */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching memberDecorator
export function decoratorOn(node: ts.HasDecorators, name: string): ts.Decorator | null {
    const decorators = ts.getDecorators(node) ?? [];
    return decorators.find((decorator: ts.Decorator) => decoratorName(decorator) === name) ?? null;
}

/**
 * The first argument of a class decorator as a string (`@ApiPath('/x')`, `@ApiPath(X_PATH)`), else
 * null. A same-module constant resolves; anything else is recorded on `diagnostics`.
 */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function decoratorStringArg(
    cls: ts.ClassDeclaration,
    name: string,
    constants: ModuleStringConstants = new ModuleStringConstants(new Map<string, string>()),
    diagnostics: DecoratorArgDiagnostics | null = null,
    api: string = name,
): string | null {
    const decorator = classDecorators(cls).find((d: ts.Decorator) => decoratorName(d) === name);
    if (decorator === undefined) return null;
    const arg = decoratorArgValue(decoratorArgs(decorator)[0], constants);
    reportUnresolved(diagnostics, api, name, null, arg, decorator);
    return arg.value;
}

/** The constructor's parameters, or [] when the class declares no constructor. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function constructorParamsOf(cls: ts.ClassDeclaration): readonly ts.ParameterDeclaration[] {
    for (const member of cls.members) {
        if (ts.isConstructorDeclaration(member)) return member.parameters;
    }
    return [];
}

/**
 * The bare name of a type reference (`GmailApi`, or `gmail.GmailApi` -> `GmailApi`), else null.
 * Generic wrappers are deliberately NOT unwrapped: `Provider<GmailApi>` hands out the contract
 * lazily, which is still a use, but it is not the shape any of these seams take today and guessing
 * at type arguments would start matching things that merely mention a contract.
 */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function typeReferenceName(type: ts.TypeNode | undefined): string | null {
    if (type === undefined || !ts.isTypeReferenceNode(type)) return null;
    const name = type.typeName;
    if (ts.isIdentifier(name)) return name.text;
    return ts.isQualifiedName(name) && ts.isIdentifier(name.right) ? name.right.text : null;
}

/** Every type name in the class's `implements` clause — the contracts this class IS, not ones it calls. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function implementedTypeNames(cls: ts.ClassDeclaration): Set<string> {
    const names = new Set<string>();
    for (const clause of cls.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const type of clause.types) {
            if (ts.isIdentifier(type.expression)) names.add(type.expression.text);
        }
    }
    return names;
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
export function isAbstractClass(cls: ts.ClassDeclaration): boolean {
    return (ts.getModifiers(cls) ?? []).some(
        (m: ts.Modifier) => m.kind === ts.SyntaxKind.AbstractKeyword,
    );
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
export function hasClassDecorator(cls: ts.ClassDeclaration, name: string): boolean {
    return classDecorators(cls).some((d: ts.Decorator) => decoratorName(d) === name);
}

/**
 * The service a client-factory call aims at, from its config argument:
 * `createRpcClient(WarmupApi, new ClientConfig('helper-fsdb'))` → `'helper-fsdb'`.
 *
 * Only a `new <Xxx>ClientConfig('<string literal>')` yields a name. A variable, a template string
 * or a computed expression yields null — the target is genuinely unknown at scan time, and the
 * runtime graph must fall back to fan-out (loudly) rather than guess.
 */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function targetServiceOf(call: ts.CallExpression): string | null {
    if (call.arguments.length < 2) return null;
    const config = call.arguments[1];
    if (!ts.isNewExpression(config) || !ts.isIdentifier(config.expression)) return null;
    if (!config.expression.text.endsWith(CLIENT_CONFIG_SUFFIX)) return null;
    const first = config.arguments?.[0];
    if (first === undefined || !ts.isStringLiteral(first)) return null;
    return first.text.length > 0 ? first.text : null;
}

// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function calleeMethodName(call: ts.CallExpression): string | null {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isIdentifier(callee)) return callee.text;
    return null;
}

// webpieces-disable no-function-outside-class -- pure path predicate, matching the sibling helpers in di-graph/bindings.ts
export function isTestFile(fileName: string): boolean {
    return (
        fileName.includes('/__tests__/') ||
        fileName.includes('.spec.') ||
        fileName.includes('.test.')
    );
}

/** {api, owner, type:'rpc'|'pubsub'} for an in-repo contract class, else null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function apiClassInfoFromNode(
    node: ts.Node,
    project: string,
    diagnostics: DecoratorArgDiagnostics | null = null,
): ApiClassInfo | null {
    return ts.isClassDeclaration(node) ? apiClassInfoFrom(node, project, diagnostics) : null;
}

/**
 * {api, owner, type:'external'} for a VENDOR contract, else null.
 *
 * A vendor contract cannot be detected the way an in-repo one is. It carries no @ApiPath (there is
 * no route — the call leaves through a vendor SDK), and it is usually a plain `interface` bound to a
 * Symbol token, which is not even a class. So inside a project the workspace has DECLARED external
 * (`runtime-architecture.externalApiPaths`) the signal is structural instead: an exported
 * `interface`/`abstract class` whose name ends in `Api`. That deliberately picks up `GmailApi` and
 * `StorageApi` while leaving their DTOs, `*Config` types and `*Client` implementations alone.
 */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function externalApiInfoFrom(node: ts.Node, project: string): ApiClassInfo | null {
    const named =
        ts.isInterfaceDeclaration(node) || (ts.isClassDeclaration(node) && isAbstractClass(node));
    if (!named || !node.name || !isExported(node)) return null;
    const api = node.name.text;
    if (!api.endsWith(EXTERNAL_CONTRACT_SUFFIX)) return null;
    const externalSystem = externalSystemTagFrom(node, api);
    return externalSystem === null
        ? { api, owner: project, type: 'external', methods: [] }
        : { api, owner: project, type: 'external', methods: [], externalSystem };
}

/**
 * The `@externalSystem <kind> [label]` JSDoc tag on a vendor contract, or null when absent.
 *
 * JSDoc rather than a decorator is not a style choice: these seams are TS `interface`s, and TS has
 * no interface decorators. Without the tag the contract still renders — as the generic dashed box it
 * always was — so this is purely additive and nothing needs migrating.
 *
 * The label defaults to the contract name minus its `Api` suffix (`FirestoreAdminApi` →
 * `FirestoreAdmin`), because the label is the node IDENTITY: two contracts that mean the same system
 * must be given the SAME explicit label to converge on one node.
 *
 * An unrecognised kind is ignored rather than defaulted. Silently drawing a `@externalSystem
 * databse` typo as a generic box is recoverable; drawing it as the wrong shape teaches the reader
 * something false about the architecture.
 */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function externalSystemTagFrom(
    node: ts.Node,
    api: string,
): ExternalSystemDeclaration | null {
    for (const tag of ts.getJSDocTags(node)) {
        if (tag.tagName.text !== EXTERNAL_SYSTEM_TAG) continue;
        const comment = typeof tag.comment === 'string' ? tag.comment : '';
        const parts = comment
            .trim()
            .split(/\s+/)
            .filter((part: string) => part !== '');
        if (parts.length === 0) continue;
        const kind = parts[0].toLowerCase();
        if (!isExternalSystemKind(kind)) continue;
        const label = parts.slice(1).join(' ').trim();
        return { kind, label: label === '' ? api.replace(/Api$/, '') : label };
    }
    return null;
}

/** True when the declaration carries an `export` modifier. */
// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
export function isExported(node: ts.InterfaceDeclaration | ts.ClassDeclaration): boolean {
    return (ts.getModifiers(node) ?? []).some(
        (m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
}

// webpieces-disable no-function-outside-class -- recursive fs walker, matching the AST-helper style here
export function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') out.push(...collectTsFiles(full));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}
