/**
 * API Usage Scanner
 *
 * Derives, by scanning real source (not a declaration file), how every project
 * relates to the api-lib projects it depends on. This is the single source of
 * truth for the `apiRelations` field in architecture/dependencies.json AND for
 * the runtime microservice graph.
 *
 * Signals (all resolved through the TypeScript checker, so re-exports resolve):
 *   - IMPLEMENTS: `apiFactory.addRoutes(XxxApi, XxxController)` — the registration
 *                 that actually SERVES the contract over the wire. We deliberately
 *                 do NOT use `class Ctrl extends XxxApi`: a class can extend an API
 *                 as an in-process test double / simulator (e.g. Server2Simulator)
 *                 without ever serving it — only `addRoutes` proves a served route.
 *   - USES:       `factory.createRpcClient(XxxApi, ...)`    → rpc client
 *                 `factory.createPubSubClient(XxxApi, ...)` → pubsub (Cloud Tasks) client
 * An api-lib is DETECTED, not tagged: a project exporting an `abstract class`
 * carrying `@ApiPath` owns that API. Its transport is `@PubSub` → 'pubsub', else 'rpc'.
 *
 * Contracts are indexed from SOURCE in a pre-pass (ApiSourceIndexBuilder) rather than
 * from wherever the checker resolves an import to. A consumer without a tsconfig.base
 * `paths` entry resolves `import { XxxApi } from '@scope/xxx-api'` through node_modules
 * to the package's BUILT `dist/**.d.ts` — and tsc ERASES decorators when emitting
 * declarations, so `@ApiPath` can never be read there. Keying off the resolved
 * declaration therefore dropped whole services from the graph, silently. See
 * `recoverFromDeclaration`.
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import type { EnhancedGraph } from '../graph-sorter';
import { ProjectInfo } from '../project-info';
import { findProjectTsconfig } from '../di-graph/program';
import { resolveClassDeclaration, classDecorators, decoratorName } from '../di-graph/bindings';
import {
    ApiClassInfo,
    ApiRef,
    ApiTransport,
    ApiRelation,
    ProjectApiRelations,
    deriveApiRelationKind,
    sortApiRefs,
} from './api-relations';

const RPC_CLIENT_METHOD = 'createRpcClient';
const PUBSUB_CLIENT_METHOD = 'createPubSubClient';
const ADD_ROUTES_METHOD = 'addRoutes';

/**
 * An `addRoutes`/`createRpcClient`/`createPubSubClient` first argument that resolved to an
 * abstract class in a DECLARATION file which owns no indexed contract. Unambiguously a broken
 * scan (a real api-lib whose source we never indexed), never a "this isn't an API" argument —
 * so it is reported loudly instead of collapsing into a silent `return null`.
 */
export class UnresolvedApiCall {
    constructor(
        /** The project whose source makes the call. */
        public readonly project: string,
        /** The contract class name as written at the call site. */
        public readonly api: string,
        /** `path/to/file.ts:LINE` of the call site, workspace-relative. */
        public readonly at: string,
        /** The declaration file the checker resolved to (where decorators are erased). */
        public readonly declaredIn: string,
    ) {}
}

/** The whole-workspace result of a scan. */
export interface ApiScanResult {
    /** projectName -> { apiLibProject -> relation }; only projects with ≥1 relation appear. */
    relationsByProject: Map<string, ProjectApiRelations>;
    /** Every project that owns ≥1 API contract class. */
    apiLibProjects: Set<string>;
    /** apiClassName -> where it lives + its transport. */
    apiIndex: Map<string, ApiClassInfo>;
    /**
     * Projects whose production (non-test) source was actually scanned. A project with only test
     * files (e.g. an e2e harness), or one the compiler couldn't load, is ABSENT — callers must not
     * conclude "no implements/uses" for it, because its behavior was never observed.
     */
    scannedProjects: Set<string>;
    /**
     * Call sites naming a contract we could not map back to workspace source. Non-empty means the
     * graph is INCOMPLETE — callers must surface these rather than emit a green, wrong graph.
     */
    unresolvedApiCalls: UnresolvedApiCall[];
}

/** Maps an absolute source-file path to the workspace project that owns it (longest-root-prefix). */
class ProjectLocator {
    private readonly roots: ProjectRoot[];

    constructor(workspaceRoot: string, projectInfos: Map<string, ProjectInfo>) {
        const roots: ProjectRoot[] = [];
        for (const info of projectInfos.values()) {
            if (info.root === '' || info.root === '.') continue;
            roots.push(new ProjectRoot(info.name, path.resolve(workspaceRoot, info.root)));
        }
        // Longest root first so a nested project wins over its parent.
        this.roots = roots.sort((a: ProjectRoot, b: ProjectRoot) => b.abs.length - a.abs.length);
    }

    projectOf(absFile: string): string | null {
        const normalized = path.resolve(absFile);
        for (const root of this.roots) {
            if (normalized === root.abs || normalized.startsWith(root.abs + path.sep)) return root.name;
        }
        return null;
    }
}

class ProjectRoot {
    constructor(
        public readonly name: string,
        public readonly abs: string,
    ) {}
}

/**
 * Every API contract in the workspace, keyed by class name, read from SOURCE.
 *
 * Name-keyed because a call site only ever gives us a name once its import has resolved into a
 * decorator-erased declaration. Two api-libs exporting the same class name collide (last wins) —
 * the same collision the published `apiIndex` has always had.
 */
class ApiSourceIndex {
    constructor(
        public readonly byName: Map<string, ApiClassInfo>,
        public readonly owners: Set<string>,
    ) {}

    lookup(api: string): ApiClassInfo | null {
        return this.byName.get(api) ?? null;
    }
}

/**
 * Builds the ApiSourceIndex by parsing each project's own `src/**` directly.
 *
 * Deliberately parser-only (no ts.Program, no checker): we need the decorators exactly as
 * written, and a plain parse cannot be diverted to a `.d.ts` by module resolution — which is
 * the entire bug this guards against. It is also cheap enough to run over every project.
 */
class ApiSourceIndexBuilder {
    private readonly byName = new Map<string, ApiClassInfo>();
    private readonly owners = new Set<string>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly projectInfos: Map<string, ProjectInfo>,
    ) {}

    build(): ApiSourceIndex {
        for (const info of this.projectInfos.values()) {
            if (info.root === '' || info.root === '.') continue;
            this.indexProject(info);
        }
        return new ApiSourceIndex(this.byName, this.owners);
    }

    private indexProject(info: ProjectInfo): void {
        const srcDir = path.join(path.resolve(this.workspaceRoot, info.root), 'src');
        if (!fs.existsSync(srcDir)) return;
        for (const file of collectTsFiles(srcDir)) {
            if (isTestFile(file)) continue; // tests are not production topology
            const text = fs.readFileSync(file, 'utf8');
            const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            this.indexNode(sourceFile, info.name);
        }
    }

    private indexNode(node: ts.Node, project: string): void {
        if (ts.isClassDeclaration(node)) {
            const info = apiClassInfoFrom(node, project);
            if (info) {
                this.owners.add(project);
                this.byName.set(info.api, info);
            }
        }
        ts.forEachChild(node, (child: ts.Node) => this.indexNode(child, project));
    }
}

/** Per-owner accumulator that dedupes API refs while a single project is scanned. */
class RelationAccumulator {
    private readonly implementsByOwner = new Map<string, Map<string, ApiRef>>();
    private readonly usesByOwner = new Map<string, Map<string, ApiRef>>();

    addImplements(owner: string, ref: ApiRef): void {
        ensureRefMap(this.implementsByOwner, owner).set(ref.api, ref);
    }

    addUses(owner: string, ref: ApiRef): void {
        ensureRefMap(this.usesByOwner, owner).set(ref.api, ref);
    }

    /** Build the deterministic { owner -> relation } record, owners in sorted order. */
    toRelations(): ProjectApiRelations {
        const owners = new Set<string>([...this.implementsByOwner.keys(), ...this.usesByOwner.keys()]);
        const relations: ProjectApiRelations = {};
        for (const owner of [...owners].sort()) {
            const implementsRefs = sortApiRefs([...(this.implementsByOwner.get(owner)?.values() ?? [])]);
            const usesRefs = sortApiRefs([...(this.usesByOwner.get(owner)?.values() ?? [])]);
            const relation: ApiRelation = {
                kind: deriveApiRelationKind(implementsRefs, usesRefs),
                implements: implementsRefs,
                uses: usesRefs,
            };
            relations[owner] = relation;
        }
        return relations;
    }

    isEmpty(): boolean {
        return this.implementsByOwner.size === 0 && this.usesByOwner.size === 0;
    }
}

// webpieces-disable no-function-outside-class -- tiny map helper, matching the AST-helper style of di-graph/bindings.ts
function ensureRefMap(map: Map<string, Map<string, ApiRef>>, owner: string): Map<string, ApiRef> {
    let inner = map.get(owner);
    if (!inner) {
        inner = new Map<string, ApiRef>();
        map.set(owner, inner);
    }
    return inner;
}

/** Statically scans every project for its api-lib implements/uses relationships. */
export class ApiUsageScanner {
    private readonly locator: ProjectLocator;
    private readonly relationsByProject = new Map<string, ProjectApiRelations>();
    private readonly scannedProjects = new Set<string>();
    private readonly unresolvedApiCalls: UnresolvedApiCall[] = [];
    private sourceIndex = new ApiSourceIndex(new Map<string, ApiClassInfo>(), new Set<string>());

    constructor(
        private readonly workspaceRoot: string,
        private readonly projectInfos: Map<string, ProjectInfo>,
    ) {
        this.locator = new ProjectLocator(workspaceRoot, projectInfos);
    }

    scan(): ApiScanResult {
        // Pre-pass: every contract, from source, BEFORE any call site is resolved — a call site in
        // one project routinely names a contract owned by a project we have not walked yet.
        this.sourceIndex = new ApiSourceIndexBuilder(this.workspaceRoot, this.projectInfos).build();
        for (const info of this.projectInfos.values()) {
            if (info.root === '' || info.root === '.') continue;
            this.scanProject(info);
        }
        return {
            relationsByProject: this.relationsByProject,
            apiLibProjects: this.sourceIndex.owners,
            apiIndex: this.sourceIndex.byName,
            scannedProjects: this.scannedProjects,
            unresolvedApiCalls: this.unresolvedApiCalls,
        };
    }

    private scanProject(info: ProjectInfo): void {
        const program = createScanProgram(path.resolve(this.workspaceRoot, info.root));
        if (!program) return;
        const checker = program.getTypeChecker();
        const accumulator = new RelationAccumulator();
        let scannedProductionFile = false;

        for (const sourceFile of program.getSourceFiles()) {
            if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('/node_modules/')) continue;
            if (isTestFile(sourceFile.fileName)) continue; // tests are not production topology
            // Only this project's OWN files — imported api-lib source is in the program too.
            if (this.locator.projectOf(sourceFile.fileName) !== info.name) continue;
            scannedProductionFile = true;
            this.visit(sourceFile, checker, info.name, accumulator);
        }

        // Record coverage only when we actually saw production source — an all-test project (e2e)
        // stays absent so the validator won't wrongly flag its api-lib deps as unused.
        if (scannedProductionFile) this.scannedProjects.add(info.name);
        if (!accumulator.isEmpty()) this.relationsByProject.set(info.name, accumulator.toRelations());
    }

    private visit(node: ts.Node, checker: ts.TypeChecker, project: string, acc: RelationAccumulator): void {
        // Contract classes are indexed by the source pre-pass, so only calls matter here.
        if (ts.isCallExpression(node)) this.recordCall(node, checker, project, acc);
        ts.forEachChild(node, (child: ts.Node) => this.visit(child, checker, project, acc));
    }

    private recordCall(
        call: ts.CallExpression,
        checker: ts.TypeChecker,
        project: string,
        acc: RelationAccumulator,
    ): void {
        const method = calleeMethodName(call);
        if (method === null || call.arguments.length === 0) return;
        if (method === ADD_ROUTES_METHOD) {
            const info = this.apiInfoFromExpr(call.arguments[0], checker, project);
            if (info) acc.addImplements(info.owner, { api: info.api, type: info.type });
            return;
        }
        if (method === RPC_CLIENT_METHOD || method === PUBSUB_CLIENT_METHOD) {
            const info = this.apiInfoFromExpr(call.arguments[0], checker, project);
            if (info) acc.addUses(info.owner, { api: info.api, type: info.type });
        }
    }

    /** Resolve an expression to the API contract it names, or null if it is not one. */
    private apiInfoFromExpr(expr: ts.Expression, checker: ts.TypeChecker, project: string): ApiClassInfo | null {
        const decl = resolveClassDeclaration(expr, checker);
        if (!decl) return null;
        const fromSource = this.apiClassInfoFor(decl);
        return fromSource ?? this.recoverFromDeclaration(decl, expr, project);
    }

    /**
     * The checker landed on a BUILT declaration instead of source — the consumer has no
     * tsconfig.base `paths` entry for the api-lib, so the import went through node_modules to
     * `dist/**.d.ts`. tsc erases decorators when emitting declarations, so `@ApiPath` is simply
     * not there and never will be. Recover the contract by name from the source index; the graph
     * is then correct no matter how the consumer's tsconfig is laid out.
     */
    private recoverFromDeclaration(
        decl: ts.ClassDeclaration,
        expr: ts.Expression,
        project: string,
    ): ApiClassInfo | null {
        // An abstract class is the shape of a contract; a non-abstract argument is genuinely not one.
        if (!decl.getSourceFile().isDeclarationFile || !isAbstractClass(decl) || !decl.name) return null;
        const recovered = this.sourceIndex.lookup(decl.name.text);
        if (recovered) return recovered;
        // Abstract, in a .d.ts, yet no workspace source owns it — the scan is blind here. Say so.
        this.unresolvedApiCalls.push(
            new UnresolvedApiCall(
                project,
                decl.name.text,
                this.relativeLocation(expr),
                this.relativePath(decl.getSourceFile().fileName),
            ),
        );
        return null;
    }

    /** `path/to/file.ts:LINE` for `node`, workspace-relative, for a human-readable report. */
    private relativeLocation(node: ts.Node): string {
        const sourceFile = node.getSourceFile();
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        return `${this.relativePath(sourceFile.fileName)}:${position.line + 1}`;
    }

    private relativePath(absFile: string): string {
        return path.relative(this.workspaceRoot, absFile);
    }

    /** {api, owner, type} when `cls` is an `abstract class` carrying `@ApiPath` IN SOURCE, else null. */
    private apiClassInfoFor(cls: ts.ClassDeclaration): ApiClassInfo | null {
        if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return null;
        const owner = this.locator.projectOf(cls.getSourceFile().fileName);
        if (owner === null) return null;
        return { api: cls.name.text, owner, type: apiTransport(cls) };
    }
}

/**
 * Run the scan and attach the derived `apiRelations` onto each graph entry in
 * place. Shared by `architecture:generate` (which then saves) and
 * `architecture:validate-architecture-unchanged` (which regenerates in memory
 * and must attach the SAME field, or it would see a phantom diff). Returns the
 * full scan so callers (validators, runtime graph) can reuse the api index.
 */
// webpieces-disable no-function-outside-class -- module entry point, mirrors generateReducedGraph/collectBindings
export function scanAndAttachApiRelations(
    workspaceRoot: string,
    graph: EnhancedGraph,
    projectInfos: Map<string, ProjectInfo>,
): ApiScanResult {
    const result = new ApiUsageScanner(workspaceRoot, projectInfos).scan();
    for (const projectName of result.relationsByProject.keys()) {
        const entry = graph[projectName];
        if (entry) entry.apiRelations = result.relationsByProject.get(projectName);
    }
    return result;
}

/**
 * Loud, actionable report for contracts the scan could not map to source. Callers print this
 * instead of emitting a green graph that is quietly missing relations. Not fatal: a contract
 * from a genuinely EXTERNAL (published, non-workspace) api-lib legitimately has no source here.
 */
// webpieces-disable no-function-outside-class -- pure formatter, mirrors describeUnclassifiedApiDep
export function describeUnresolvedApiCalls(calls: UnresolvedApiCall[]): string {
    const lines = [
        `⚠️  ${calls.length} API contract(s) resolved to a declaration file with no matching workspace source.`,
        `   Decorators (@ApiPath) are ERASED in .d.ts output, so these relations are MISSING from the graph:`,
    ];
    for (const call of calls) {
        lines.push(`     • ${call.api} at ${call.at} (${call.project}) → resolved to ${call.declaredIn}`);
    }
    lines.push(
        `   If the api-lib IS in this workspace, add a tsconfig.base.json 'paths' entry mapping it to its`,
        `   src/index.ts, or confirm its project root is registered. If it is a published external package,`,
        `   this relation cannot be derived and the graph edge will not appear.`,
    );
    return lines.join('\n');
}

/**
 * Build a program for scanning ONE project. Prefers the project's compile tsconfig; but when that
 * is a solution-style tsconfig (only `references`, no `files`/`include` — e.g. legacy-server), it
 * yields zero files, so we fall back to globbing the project's own `src/**` and reuse the resolved
 * compiler options (which carry tsconfig.base `paths` for cross-package @webpieces resolution).
 *
 * `paths` is a PREFERENCE, not a precondition: it lets imports resolve straight to source. Without
 * it they land on a decorator-erased `dist/**.d.ts`, which the source index recovers from — see
 * ApiUsageScanner.recoverFromDeclaration.
 */
// webpieces-disable no-function-outside-class -- ts Program factory, mirrors di-graph/program.ts
function createScanProgram(projectRootAbs: string): ts.Program | null {
    const configPath = findProjectTsconfig(projectRootAbs);
    if (!configPath) return buildProgramFromSrc(projectRootAbs, {});
    const host = Object.assign({}, ts.sys, {
        onUnRecoverableConfigFileDiagnostic: (): void => undefined,
    }) as ts.ParseConfigFileHost;
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed) return null;
    if (parsed.fileNames.length > 0) return ts.createProgram(parsed.fileNames, parsed.options);
    return buildProgramFromSrc(projectRootAbs, parsed.options);
}

// webpieces-disable no-function-outside-class -- ts Program factory helper, mirrors di-graph/program.ts
function buildProgramFromSrc(projectRootAbs: string, options: ts.CompilerOptions): ts.Program | null {
    const srcDir = path.join(projectRootAbs, 'src');
    if (!fs.existsSync(srcDir)) return null;
    const files = collectTsFiles(srcDir);
    return files.length > 0 ? ts.createProgram(files, options) : null;
}

// webpieces-disable no-function-outside-class -- recursive fs walker, matching the AST-helper style here
function collectTsFiles(dir: string): string[] {
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

/** {api, owner: `project`, type} when `cls` is an `abstract class` carrying `@ApiPath`, else null. */
// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
function apiClassInfoFrom(cls: ts.ClassDeclaration, project: string): ApiClassInfo | null {
    if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return null;
    return { api: cls.name.text, owner: project, type: apiTransport(cls) };
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
function apiTransport(cls: ts.ClassDeclaration): ApiTransport {
    return hasClassDecorator(cls, 'PubSub') ? 'pubsub' : 'rpc';
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
function isAbstractClass(cls: ts.ClassDeclaration): boolean {
    return (ts.getModifiers(cls) ?? []).some((m: ts.Modifier) => m.kind === ts.SyntaxKind.AbstractKeyword);
}

// webpieces-disable no-function-outside-class -- pure AST predicate, matching the sibling helpers in di-graph/bindings.ts
function hasClassDecorator(cls: ts.ClassDeclaration, name: string): boolean {
    return classDecorators(cls).some((d: ts.Decorator) => decoratorName(d) === name);
}

// webpieces-disable no-function-outside-class -- pure AST accessor, matching the sibling helpers in di-graph/bindings.ts
function calleeMethodName(call: ts.CallExpression): string | null {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isIdentifier(callee)) return callee.text;
    return null;
}

// webpieces-disable no-function-outside-class -- pure path predicate, matching the sibling helpers in di-graph/bindings.ts
function isTestFile(fileName: string): boolean {
    return (
        fileName.includes('/__tests__/') ||
        fileName.includes('.spec.') ||
        fileName.includes('.test.')
    );
}
