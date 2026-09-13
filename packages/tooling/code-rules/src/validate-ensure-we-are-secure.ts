/** Audits explicit HTTP authentication and IPC-only contracts in directly changed projects. */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    EnsureWeAreSecureConfig,
    getChangedFiles,
    detectBase,
    InformAiError,
    Option,
    RuleFailError,
    RULE_NAMES,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { CodeValidator, ExecutorResult } from './code-validator';

const HTTP_AUTH = new Set([
    'WpAuthJwt',
    'WpAuthOidc',
    'WpAuthWebhook',
    'WpAuthSharedSecret',
    'WpAuthApiKey',
    'WpAuthLocalOnly',
    'WpAuthPublic',
]);
const CONTRACT_DECORATORS = new Set([
    ...HTTP_AUTH,
    'ApiPath',
    'Endpoint',
    'WpInternal',
    'WpIpcEndpoint',
]);

export class SecurityContractViolation {
    constructor(
        readonly file: string,
        readonly line: number,
        readonly code: string,
        readonly message: string,
    ) {}
}

class DecoratorUse {
    constructor(
        readonly name: string,
        readonly decorator: ts.Decorator,
        readonly call: ts.CallExpression | null,
    ) {}
}

class CanonicalImports {
    readonly named = new Map<string, string>();
    readonly namespaces = new Set<string>();
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function isCanonicalModule(moduleName: string): boolean {
    return (
        moduleName === '@webpieces/core-util' ||
        moduleName === '@webpieces/core-util/ipc' ||
        moduleName.endsWith('/core-util/src/http/decorators') ||
        moduleName.includes('/core-util/src/ipc/')
    );
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function importsOf(source: ts.SourceFile): CanonicalImports {
    const result = new CanonicalImports();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
        if (!isCanonicalModule(statement.moduleSpecifier.text)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const item of bindings.elements) {
                const exported = item.propertyName?.text ?? item.name.text;
                if (CONTRACT_DECORATORS.has(exported)) result.named.set(item.name.text, exported);
            }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
            result.namespaces.add(bindings.name.text);
        }
    }
    return result;
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function decoratorUse(decorator: ts.Decorator, imports: CanonicalImports): DecoratorUse | null {
    const expr = decorator.expression;
    const call = ts.isCallExpression(expr) ? expr : null;
    const callee = call?.expression ?? expr;
    if (ts.isIdentifier(callee)) {
        const canonical = imports.named.get(callee.text);
        return canonical ? new DecoratorUse(canonical, decorator, call) : null;
    }
    if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        imports.namespaces.has(callee.expression.text)
    ) {
        return CONTRACT_DECORATORS.has(callee.name.text)
            ? new DecoratorUse(callee.name.text, decorator, call)
            : null;
    }
    return null;
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function decoratorsOf(node: ts.Node, imports: CanonicalImports): DecoratorUse[] {
    if (!ts.canHaveDecorators(node)) return [];
    return (ts.getDecorators(node) ?? [])
        .map((decorator: ts.Decorator) => decoratorUse(decorator, imports))
        .filter((use): use is DecoratorUse => use !== null);
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function lineOf(source: ts.SourceFile, node: ts.Node): number {
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function literalId(use: DecoratorUse): string | null {
    const arg = use.call?.arguments[0];
    if (!arg || (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))) return null;
    const value = arg.text.trim();
    return value.length > 0 ? value : null;
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function methodName(method: ts.MethodDeclaration): string {
    return ts.isIdentifier(method.name) || ts.isStringLiteral(method.name)
        ? method.name.text
        : method.name.getText();
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function hasPromiseReturn(method: ts.MethodDeclaration): boolean {
    const type = method.type;
    return (
        type !== undefined &&
        ts.isTypeReferenceNode(type) &&
        ts.isIdentifier(type.typeName) &&
        type.typeName.text === 'Promise'
    );
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function add(
    out: SecurityContractViolation[],
    file: string,
    source: ts.SourceFile,
    node: ts.Node,
    code: string,
    message: string,
): void {
    out.push(new SecurityContractViolation(file, lineOf(source, node), code, message));
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function checkHttpMethod(
    file: string,
    source: ts.SourceFile,
    method: ts.MethodDeclaration,
    uses: DecoratorUse[],
    out: SecurityContractViolation[],
): void {
    const endpoints = uses.filter((use: DecoratorUse) => use.name === 'Endpoint');
    const auth = uses.filter((use: DecoratorUse) => HTTP_AUTH.has(use.name));
    const ipc = uses.filter((use: DecoratorUse) => use.name === 'WpIpcEndpoint');
    const label = methodName(method);
    if (endpoints.length > 1)
        add(
            out,
            file,
            source,
            method,
            'HTTP_MULTIPLE_ENDPOINTS',
            `${label} has multiple @Endpoint decorators.`,
        );
    if (endpoints.length > 0 && auth.length !== 1) {
        add(
            out,
            file,
            source,
            method,
            'HTTP_AUTH_COUNT',
            `${label} must have exactly one method-level @WpAuth* decorator; found ${auth.length}. Prefer an authenticated mode; use @WpAuthPublic('reason') only for deliberate anonymous access.`,
        );
    }
    if (endpoints.length === 0 && auth.length > 0)
        add(
            out,
            file,
            source,
            auth[0]!.decorator,
            'HTTP_ORPHAN_AUTH',
            `${label} has @WpAuth* but no @Endpoint.`,
        );
    for (const publicUse of auth.filter((use: DecoratorUse) => use.name === 'WpAuthPublic')) {
        if (literalId(publicUse) === null)
            add(
                out,
                file,
                source,
                publicUse.decorator,
                'HTTP_PUBLIC_REASON',
                `${label} must use @WpAuthPublic('non-empty reason').`,
            );
    }
    if (ipc.length > 0)
        add(
            out,
            file,
            source,
            ipc[0]!.decorator,
            'HTTP_IPC_MIX',
            `${label} mixes HTTP and IPC endpoint metadata.`,
        );
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function checkInternalMethod(
    file: string,
    source: ts.SourceFile,
    method: ts.MethodDeclaration,
    uses: DecoratorUse[],
    out: SecurityContractViolation[],
    ids: Set<string>,
): void {
    const ipc = uses.filter((use: DecoratorUse) => use.name === 'WpIpcEndpoint');
    const endpoint = uses.some((use: DecoratorUse) => use.name === 'Endpoint');
    const auth = uses.some((use: DecoratorUse) => HTTP_AUTH.has(use.name));
    const label = methodName(method);
    if (ipc.length !== 1)
        add(
            out,
            file,
            source,
            method,
            'IPC_ENDPOINT_COUNT',
            `${label} must have exactly one @WpIpcEndpoint('stable-method-id'); found ${ipc.length}.`,
        );
    if (endpoint || auth)
        add(
            out,
            file,
            source,
            method,
            'IPC_HTTP_MIX',
            `${label} is internal and cannot use @Endpoint or @WpAuth*.`,
        );
    if (method.parameters.length !== 1)
        add(
            out,
            file,
            source,
            method,
            'IPC_DTO_COUNT',
            `${label} must accept exactly one DTO argument; found ${method.parameters.length}.`,
        );
    if (!hasPromiseReturn(method))
        add(
            out,
            file,
            source,
            method,
            'IPC_PROMISE_RETURN',
            `${label} must declare a Promise return type.`,
        );
    for (const use of ipc) {
        const id = literalId(use);
        if (id === null)
            add(
                out,
                file,
                source,
                use.decorator,
                'IPC_METHOD_ID',
                `${label} requires a non-empty inline stable method id.`,
            );
        else if (ids.has(id))
            add(
                out,
                file,
                source,
                use.decorator,
                'IPC_DUPLICATE_METHOD_ID',
                `${label} duplicates IPC method id '${id}'.`,
            );
        else ids.add(id);
    }
}

class InternalApiId {
    constructor(
        readonly id: string,
        readonly file: string,
        readonly source: ts.SourceFile,
        readonly node: ts.Node,
    ) {}
}

class ApiClassAudit {
    readonly classUses: DecoratorUse[];
    readonly methods: ts.MethodDeclaration[];
    readonly methodUses: DecoratorUse[][];
    readonly apiPaths: DecoratorUse[];
    readonly internals: DecoratorUse[];
    readonly classAuth: DecoratorUse[];
    readonly hasHttpMethod: boolean;
    readonly hasIpcMethod: boolean;
    readonly className: string;

    constructor(
        readonly statement: ts.ClassDeclaration,
        imports: CanonicalImports,
    ) {
        this.classUses = decoratorsOf(statement, imports);
        this.methods = statement.members.filter(ts.isMethodDeclaration);
        this.methodUses = this.methods.map((method: ts.MethodDeclaration) =>
            decoratorsOf(method, imports),
        );
        this.apiPaths = this.classUses.filter((use: DecoratorUse) => use.name === 'ApiPath');
        this.internals = this.classUses.filter((use: DecoratorUse) => use.name === 'WpInternal');
        this.classAuth = this.classUses.filter((use: DecoratorUse) => HTTP_AUTH.has(use.name));
        this.hasHttpMethod = this.methodUses.some((uses: DecoratorUse[]) =>
            uses.some((use: DecoratorUse) => use.name === 'Endpoint'),
        );
        this.hasIpcMethod = this.methodUses.some((uses: DecoratorUse[]) =>
            uses.some((use: DecoratorUse) => use.name === 'WpIpcEndpoint'),
        );
        this.className = statement.name?.text ?? '<anonymous class>';
    }

    get isHttp(): boolean {
        return this.apiPaths.length > 0 || this.hasHttpMethod;
    }

    get isInternal(): boolean {
        return this.internals.length > 0 || this.hasIpcMethod;
    }
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function checkClassShape(
    file: string,
    source: ts.SourceFile,
    audit: ApiClassAudit,
    out: SecurityContractViolation[],
): void {
    if (audit.hasHttpMethod && audit.apiPaths.length === 0)
        add(
            out,
            file,
            source,
            audit.statement,
            'HTTP_MISSING_API_PATH',
            `${audit.className} has @Endpoint methods but no @ApiPath.`,
        );
    if (audit.hasIpcMethod && audit.internals.length === 0)
        add(
            out,
            file,
            source,
            audit.statement,
            'IPC_MISSING_INTERNAL',
            `${audit.className} has @WpIpcEndpoint methods but no @WpInternal('stable-api-id').`,
        );
    if (audit.apiPaths.length > 1)
        add(
            out,
            file,
            source,
            audit.statement,
            'HTTP_API_PATH_COUNT',
            `${audit.className} has multiple @ApiPath decorators.`,
        );
    if (audit.internals.length > 1)
        add(
            out,
            file,
            source,
            audit.statement,
            'IPC_INTERNAL_COUNT',
            `${audit.className} has multiple @WpInternal decorators.`,
        );
    if (audit.classAuth.length > 0)
        add(
            out,
            file,
            source,
            audit.classAuth[0]!.decorator,
            'HTTP_CLASS_AUTH',
            `${audit.className} cannot declare class-level @WpAuth*; annotate every @Endpoint method.`,
        );
    if (audit.isHttp && audit.isInternal)
        add(
            out,
            file,
            source,
            audit.statement,
            'HTTP_IPC_CLASS_MIX',
            `${audit.className} mixes HTTP and internal IPC contract metadata.`,
        );
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function checkClassMethods(
    file: string,
    source: ts.SourceFile,
    audit: ApiClassAudit,
    out: SecurityContractViolation[],
    apiIds: InternalApiId[],
): void {
    if (audit.internals.length === 0) {
        if (audit.isHttp)
            audit.methods.forEach((method: ts.MethodDeclaration, index: number) =>
                checkHttpMethod(file, source, method, audit.methodUses[index]!, out),
            );
        return;
    }
    const internal = audit.internals[0]!;
    const id = literalId(internal);
    if (id === null)
        add(
            out,
            file,
            source,
            internal.decorator,
            'IPC_API_ID',
            `${audit.className} requires @WpInternal('non-empty-stable-api-id').`,
        );
    else apiIds.push(new InternalApiId(id, file, source, internal.decorator));
    if (audit.apiPaths.length > 0)
        add(
            out,
            file,
            source,
            audit.apiPaths[0]!.decorator,
            'IPC_API_PATH',
            `${audit.className} is internal and cannot use @ApiPath.`,
        );
    const ids = new Set<string>();
    audit.methods.forEach((method: ts.MethodDeclaration, index: number) =>
        checkInternalMethod(file, source, method, audit.methodUses[index]!, out, ids),
    );
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function auditFile(
    file: string,
    workspaceRoot: string,
    apiIds: InternalApiId[],
): SecurityContractViolation[] {
    const content = fs.readFileSync(path.join(workspaceRoot, file), 'utf-8');
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const imports = importsOf(source);
    const out: SecurityContractViolation[] = [];
    for (const statement of source.statements) {
        if (!ts.isClassDeclaration(statement)) continue;
        const audit = new ApiClassAudit(statement, imports);
        if (!audit.isHttp && !audit.isInternal && audit.classAuth.length === 0) continue;
        checkClassShape(file, source, audit, out);
        checkClassMethods(file, source, audit, out, apiIds);
    }
    return out;
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function owningProjectJson(workspaceRoot: string, relativeFile: string): string | null {
    let dir = path.dirname(relativeFile);
    while (dir !== '.' && dir !== '') {
        const candidate = path.join(dir, 'project.json');
        if (fs.existsSync(path.join(workspaceRoot, candidate))) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return fs.existsSync(path.join(workspaceRoot, 'project.json')) ? 'project.json' : null;
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
export function findDirectlyChangedProjectRoots(
    workspaceRoot: string,
    changedFiles: string[],
): string[] {
    const roots = new Set<string>();
    for (const file of changedFiles) {
        const projectJson = owningProjectJson(workspaceRoot, file);
        if (projectJson !== null) roots.add(path.dirname(projectJson));
    }
    return [...roots].sort();
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
function projectFiles(workspaceRoot: string, projectRoot: string): string[] {
    const files: string[] = [];
    const fullRoot = path.join(workspaceRoot, projectRoot);
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git')
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (
                /\.tsx?$/.test(entry.name) &&
                !entry.name.endsWith('.d.ts') &&
                !entry.name.endsWith('.spec.ts') &&
                !entry.name.endsWith('.test.ts') &&
                !entry.name.endsWith('.spec.tsx') &&
                !entry.name.endsWith('.test.tsx')
            ) {
                const rel = path.relative(workspaceRoot, full);
                const owner = owningProjectJson(workspaceRoot, rel);
                if (owner !== null && path.dirname(owner) === projectRoot) files.push(rel);
            }
        }
    };
    if (fs.existsSync(fullRoot)) walk(fullRoot);
    return files.sort();
}

// webpieces-disable no-function-outside-class -- stateless TypeScript AST security validator helper
export function auditSecurityContracts(
    workspaceRoot: string,
    projectRoots: string[],
): SecurityContractViolation[] {
    const apiIds: InternalApiId[] = [];
    const files = projectRoots.flatMap((root: string) => projectFiles(workspaceRoot, root));
    const out = files.flatMap((file: string) => auditFile(file, workspaceRoot, apiIds));
    const byId = new Map<string, InternalApiId[]>();
    for (const api of apiIds) byId.set(api.id, [...(byId.get(api.id) ?? []), api]);
    for (const entry of byId.entries()) {
        const id = entry[0];
        const duplicates = entry[1];
        if (duplicates.length < 2) continue;
        for (const duplicate of duplicates)
            add(
                out,
                duplicate.file,
                duplicate.source,
                duplicate.node,
                'IPC_DUPLICATE_API_ID',
                `Duplicate internal API id '${id}'.`,
            );
    }
    return out.sort(
        (a: SecurityContractViolation, b: SecurityContractViolation) =>
            a.file.localeCompare(b.file) ||
            a.line - b.line ||
            a.code.localeCompare(b.code) ||
            a.message.localeCompare(b.message),
    );
}

// webpieces-disable no-function-outside-class -- one structured rule failure shared by tests and runner
export function securityContractsError(
    violations: readonly SecurityContractViolation[],
): RuleFailError {
    const details = violations
        .map(
            (violation: SecurityContractViolation): string =>
                `  ${violation.file}:${String(violation.line)} [${violation.code}] ${violation.message}`,
        )
        .join('\n');
    const first = violations[0];
    const message =
        'API contracts in directly changed projects are not explicit and secure.\n' + details;
    return new RuleFailError(
        RULE_NAMES.ENSURE_WE_ARE_SECURE,
        message,
        first?.line,
        first === undefined ? undefined : `[${first.code}] ${first.message}`,
        [
            new Option(
                "Put exactly one authenticated method-level @WpAuth* decorator on every @Endpoint. Use @WpAuthPublic('non-empty reason') only when anonymous access is deliberate.",
                true,
            ),
            new Option(
                "For IPC-only contracts, replace HTTP metadata with class-level @WpInternal('stable-api-id') and exactly one @WpIpcEndpoint('stable-method-id') per method.",
            ),
        ],
    );
}

// webpieces-disable no-function-outside-class -- one plumbing failure shared by tests and runner
export function missingSecurityBaseError(): InformAiError {
    return new InformAiError(
        'ensure-we-are-secure could not determine the comparison base. Set NX_BASE to the base branch or commit and retry.',
    );
}

@injectable(bindingScopeValues.Singleton)
export class EnsureWeAreSecureValidator extends CodeValidator<EnsureWeAreSecureConfig> {
    constructor(config: EnsureWeAreSecureConfig) {
        super(config, 'ensure-we-are-secure', 'ensure-we-are-secure');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        if ((this.config.mode ?? 'OFF') === 'OFF') return { success: true };
        const base = process.env['NX_BASE'] ?? detectBase(workspaceRoot);
        if (base === null || base === undefined) {
            throw missingSecurityBaseError();
        }
        const changed = getChangedFiles(workspaceRoot, base, process.env['NX_HEAD'], {
            tsOnly: false,
        });
        const roots = findDirectlyChangedProjectRoots(workspaceRoot, changed);
        const violations = auditSecurityContracts(workspaceRoot, roots);
        if (violations.length === 0) return { success: true };
        throw securityContractsError(violations);
    }
}
