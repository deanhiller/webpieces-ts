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
import {
    ApiClassInfo,
    ApiMethodMeta,
    ApiTransport,
    EmptiedApiContract,
    EndpointKind,
    ExternalSystemDeclaration,
    isExternalSystemKind,
    NonLiteralDecoratorArg,
    UnresolvedEndpointPath,
} from './api-relations';

/** Legal `@Endpoint(path, kind)` values; anything else is a source error, not a kind we invent. */
const ENDPOINT_KINDS: readonly EndpointKind[] = ['rpc', 'cloudtasks', 'cron', 'external'];

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

/**
 * The module-scope `const NAME = '<string literal>'` bindings of ONE source file.
 *
 * A contract that hoists its route to a constant (`@ApiPath(WHATSAPP_API_PATH)`) is good practice —
 * it lets a sibling contract and its callers share the symbol — but a decorator argument is read as
 * TEXT here, with no checker to constant-fold it. Without this table such an argument resolved to
 * nothing: the class lost its basePath, and a class whose every @Endpoint path was a constant
 * resolved to zero methods and was dropped from the graph entirely.
 *
 * Deliberately SAME-MODULE only. Following an import would mean resolving modules, which is exactly
 * what the source pre-pass avoids (it can be diverted to a decorator-erased `.d.ts`). A cross-module
 * constant is therefore still unresolvable — and is REPORTED rather than silently dropped, see
 * DecoratorArgDiagnostics.
 */
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
    if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) return stringValueOf(expr.expression);
    return null;
}

/**
 * ONE decorator argument that had to be a string, and what came of it.
 *
 * `value` is the string when it was a literal or resolved through a same-module constant.
 * `unresolvedName` is the argument as written (`WHATSAPP_API_PATH`) when it is present but could not
 * be reduced — the case that must be reported, never silently dropped. Both are null when the
 * argument is simply absent.
 */
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

/**
 * Collects everything this parser-only pass had to drop: decorator arguments it could not reduce to
 * a string, plus the two of those that are FATAL rather than merely lossy.
 *
 * A same-module constant now resolves, but a cross-module one (`import { PATH } from './paths'`)
 * genuinely cannot — the source pre-pass has no checker by design. That gap used to be invisible:
 * the contract simply came out with no basePath, or with fewer methods, or not at all. Recording it
 * turns a silent drop into a named one, pointing at the exact file, line and identifier.
 *
 * Three sinks, because the consequences differ. `record` is the warning stream (a @Queue name falls
 * back to a derived one, so the graph is degraded, not wrong). `recordUnresolvedPath` and
 * `recordEmptiedContract` are collected so generation can FAIL — one aggregated error naming every
 * offender, because an author fixing five constants wants all five in one run.
 */
export class DecoratorArgDiagnostics {
    private readonly found: NonLiteralDecoratorArg[] = [];
    private readonly unresolvedPaths: UnresolvedEndpointPath[] = [];
    private readonly emptied: EmptiedApiContract[] = [];

    constructor(private readonly workspaceRoot: string) {}

    /** Record `argument` (as written) as unresolvable at `node`'s location. */
    record(api: string, decorator: string, method: string | null, argument: string, node: ts.Node): void {
        this.found.push(new NonLiteralDecoratorArg(api, decorator, method, argument, this.locate(node)));
    }

    /** Record an `@Endpoint` whose path argument is unreadable — fatal, see UnresolvedEndpointPathError. */
    recordUnresolvedPath(api: string, method: string, argument: string, node: ts.Node): void {
        this.unresolvedPaths.push(new UnresolvedEndpointPath(api, method, argument, this.locate(node)));
    }

    /** Record a class that declared `declared` `@Endpoint` methods and kept none of them. */
    recordEmptiedContract(api: string, declared: number, node: ts.Node): void {
        this.emptied.push(new EmptiedApiContract(api, declared, this.locate(node)));
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

/**
 * Every `@Endpoint(path, kind)` method on a contract class, in declaration order.
 *
 * `kind` is a REQUIRED argument of the decorator, so a missing/non-literal second argument means the
 * source does not compile (or is mid-edit) — we skip the method rather than defaulting it. Defaulting
 * would put an undeclared cron or webhook into the graph as an ordinary rpc call, which is precisely
 * the blindness the required argument exists to remove.
 *
 * `path` is NOT skippable. It may be a same-module constant; an argument that is present but still
 * cannot be reduced is recorded on `diagnostics` as an UnresolvedEndpointPath, which FAILS generation
 * later. Upstream components need the URL — a client computes its request as `basePath + path` — so
 * dropping the method here shipped a contract missing routing information, and a class whose every
 * path was a constant lost every method and disappeared from the graph entirely.
 *
 * A class that declared endpoints and kept NONE of them is recorded too: `buildApiContracts` skips
 * zero-method classes, which is the door a gutted contract used to leave through unannounced.
 */
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
        const pathArg = decoratorArgValue(args[0], constants);
        const kindArg = decoratorArgValue(args[1], constants);
        reportUnresolved(diagnostics, api, 'Endpoint', name, pathArg, endpoint);
        reportUnresolved(diagnostics, api, 'Endpoint', name, kindArg, endpoint);
        if (diagnostics !== null && pathArg.unresolvedName !== null) {
            diagnostics.recordUnresolvedPath(api, name, pathArg.unresolvedName, endpoint);
        }
        const kind = kindArg.value;
        if (pathArg.value === null || kind === null || !ENDPOINT_KINDS.includes(kind as EndpointKind)) continue;
        const method: ApiMethodMeta = { name, path: pathArg.value, kind: kind as EndpointKind };
        // Only a queued or scheduled endpoint HAS a queue. Naming one for a synchronous rpc invited a
        // tool to read `methods.map(m => m.queueName)` as a provisioning list and create queues that
        // nothing will ever deliver to.
        if (QUEUED_KINDS.includes(method.kind)) {
            method.queueName = queueNameOf(member, api, name, constants, diagnostics);
        }
        methods.push(method);
    }
    // Declared endpoints, kept none: the class is about to be skipped as "zero methods" and would
    // leave no trace. Never legitimate — a routeless contract declares no @Endpoint at all.
    if (diagnostics !== null && declared > 0 && methods.length === 0) {
        diagnostics.recordEmptiedContract(api, declared, cls);
    }
    return methods;
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
export function decoratorArgs(decorator: ts.Decorator): ts.NodeArray<ts.Expression> | ts.Expression[] {
    return ts.isCallExpression(decorator.expression) ? decorator.expression.arguments : [];
}

/** The named decorator on a class member, or null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
export function memberDecorator(member: ts.ClassElement, name: string): ts.Decorator | null {
    const decorators = ts.getDecorators(member as ts.HasDecorators) ?? [];
    return decorators.find((d: ts.Decorator) => decoratorName(d) === name) ?? null;
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
    const named = ts.isInterfaceDeclaration(node) || (ts.isClassDeclaration(node) && isAbstractClass(node));
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
export function externalSystemTagFrom(node: ts.Node, api: string): ExternalSystemDeclaration | null {
    for (const tag of ts.getJSDocTags(node)) {
        if (tag.tagName.text !== EXTERNAL_SYSTEM_TAG) continue;
        const comment = typeof tag.comment === 'string' ? tag.comment : '';
        const parts = comment.trim().split(/\s+/).filter((part: string) => part !== '');
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
