/**
 * API contract AST accessors
 *
 * The pure, stateless half of the api scan: given a TypeScript node, what contract / endpoint /
 * injected type does it describe? Split out of api-scanner.ts, which owns the STATEFUL walk (project
 * programs, the source index, relation accumulation) and had grown past the file-size limit.
 *
 * Everything here is parser-level on purpose. Decorators must be read exactly as written, and a
 * plain parse cannot be diverted to a decorator-erased `.d.ts` by module resolution — the bug
 * api-scanner's source pre-pass exists to guard against.
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { classDecorators, decoratorName } from '../di-graph/bindings';
import { ApiClassInfo, ApiMethodMeta, ApiTransport, EndpointKind } from './api-relations';

/** Legal `@Endpoint(path, kind)` values; anything else is a source error, not a kind we invent. */
const ENDPOINT_KINDS: readonly EndpointKind[] = ['rpc', 'cloudtasks', 'cron', 'external'];

/**
 * Name suffix that marks an exported type in an `externalApiPaths` project as a vendor CONTRACT
 * (`GmailApi`, `StorageApi`) rather than one of the DTOs, configs or clients sitting beside it.
 * The same convention the in-repo contracts already follow, applied where no decorator can be read.
 */
const EXTERNAL_CONTRACT_SUFFIX = 'Api';

/**
 * Client-config class-name suffix whose FIRST constructor argument is the target service name —
 * `ClientConfig('helper-fsdb')` (rpc) and `TaskClientConfig('helper-fsdb')` (pubsub) both take
 * `svcName` first, and a consumer's own `XxxClientConfig` follows the same shape.
 */
const CLIENT_CONFIG_SUFFIX = 'ClientConfig';


/** {api, owner: `project`, type} when `cls` is an `abstract class` carrying `@ApiPath`, else null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function apiClassInfoFrom(cls: ts.ClassDeclaration, project: string): ApiClassInfo | null {
    if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return null;
    const api = cls.name.text;
    const info: ApiClassInfo = {
        api,
        owner: project,
        type: apiTransport(cls),
        methods: endpointMethodsOf(cls, api),
    };
    const basePath = decoratorStringArg(cls, 'ApiPath');
    if (basePath !== null) info.basePath = basePath;
    return info;
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
export function apiTransport(cls: ts.ClassDeclaration): ApiTransport {
    return hasClassDecorator(cls, 'PubSub') ? 'pubsub' : 'rpc';
}

/**
 * Every `@Endpoint(path, kind)` method on a contract class, in declaration order.
 *
 * `kind` is a REQUIRED argument of the decorator, so a missing/non-literal second argument means the
 * source does not compile (or is mid-edit) — we skip the method rather than defaulting it. Defaulting
 * would put an undeclared cron or webhook into the graph as an ordinary rpc call, which is precisely
 * the blindness the required argument exists to remove.
 */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function endpointMethodsOf(cls: ts.ClassDeclaration, api: string): ApiMethodMeta[] {
    const methods: ApiMethodMeta[] = [];
    for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const endpoint = memberDecorator(member, 'Endpoint');
        if (endpoint === null) continue;
        const args = decoratorArgs(endpoint);
        const path = args[0] !== undefined && ts.isStringLiteral(args[0]) ? args[0].text : null;
        const kind = args[1] !== undefined && ts.isStringLiteral(args[1]) ? args[1].text : null;
        if (path === null || kind === null || !ENDPOINT_KINDS.includes(kind as EndpointKind)) continue;
        const name = member.name.text;
        const override = memberDecorator(member, 'Queue');
        const queueArg = override === null ? undefined : decoratorArgs(override)[0];
        const queueName =
            queueArg !== undefined && ts.isStringLiteral(queueArg) ? queueArg.text : `${api}-${name}`;
        methods.push({ name, path, kind: kind as EndpointKind, queueName });
    }
    return methods;
}

/** The arguments of a decorator's call expression, or [] when it is a bare `@Foo` reference. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function decoratorArgs(decorator: ts.Decorator): ts.NodeArray<ts.Expression> | ts.Expression[] {
    return ts.isCallExpression(decorator.expression) ? decorator.expression.arguments : [];
}

/** The named decorator on a class member, or null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function memberDecorator(member: ts.ClassElement, name: string): ts.Decorator | null {
    const decorators = ts.getDecorators(member as ts.HasDecorators) ?? [];
    return decorators.find((d: ts.Decorator) => decoratorName(d) === name) ?? null;
}

/** The first argument of a class decorator when it is a string literal (`@ApiPath('/x')`), else null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function decoratorStringArg(cls: ts.ClassDeclaration, name: string): string | null {
    const decorator = classDecorators(cls).find((d: ts.Decorator) => decoratorName(d) === name);
    if (decorator === undefined) return null;
    const first = decoratorArgs(decorator)[0];
    return first !== undefined && ts.isStringLiteral(first) ? first.text : null;
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
    return (ts.getModifiers(cls) ?? []).some((m: ts.Modifier) => m.kind === ts.SyntaxKind.AbstractKeyword);
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
export function apiClassInfoFromNode(node: ts.Node, project: string): ApiClassInfo | null {
    return ts.isClassDeclaration(node) ? apiClassInfoFrom(node, project) : null;
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
    const named = ts.isInterfaceDeclaration(node) || (ts.isClassDeclaration(node) && isAbstractClass(node));
    if (!named || !node.name || !isExported(node)) return null;
    const api = node.name.text;
    if (!api.endsWith(EXTERNAL_CONTRACT_SUFFIX)) return null;
    return { api, owner: project, type: 'external', methods: [] };
}

/** True when the declaration carries an `export` modifier. */
// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
export function isExported(node: ts.InterfaceDeclaration | ts.ClassDeclaration): boolean {
    return (ts.getModifiers(node) ?? []).some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword);
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
