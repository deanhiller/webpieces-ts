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
    ApiRelation,
    ProjectApiRelations,
    deriveApiRelationKind,
    sortApiRefs,
} from './api-relations';

const RPC_CLIENT_METHOD = 'createRpcClient';
const PUBSUB_CLIENT_METHOD = 'createPubSubClient';
const ADD_ROUTES_METHOD = 'addRoutes';

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
    private readonly apiLibProjects = new Set<string>();
    private readonly apiIndex = new Map<string, ApiClassInfo>();
    private readonly relationsByProject = new Map<string, ProjectApiRelations>();
    private readonly scannedProjects = new Set<string>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly projectInfos: Map<string, ProjectInfo>,
    ) {
        this.locator = new ProjectLocator(workspaceRoot, projectInfos);
    }

    scan(): ApiScanResult {
        for (const info of this.projectInfos.values()) {
            if (info.root === '' || info.root === '.') continue;
            this.scanProject(info);
        }
        return {
            relationsByProject: this.relationsByProject,
            apiLibProjects: this.apiLibProjects,
            apiIndex: this.apiIndex,
            scannedProjects: this.scannedProjects,
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
        if (ts.isClassDeclaration(node)) {
            this.recordApiClass(node, project);
        } else if (ts.isCallExpression(node)) {
            this.recordCall(node, checker, acc);
        }
        ts.forEachChild(node, (child: ts.Node) => this.visit(child, checker, project, acc));
    }

    /** Register a project-owned API contract (abstract @ApiPath class) into the index. */
    private recordApiClass(cls: ts.ClassDeclaration, project: string): void {
        const own = this.apiClassInfoFor(cls);
        if (!own) return;
        this.apiLibProjects.add(project);
        this.apiIndex.set(own.api, own);
    }

    private recordCall(call: ts.CallExpression, checker: ts.TypeChecker, acc: RelationAccumulator): void {
        const method = calleeMethodName(call);
        if (method === null || call.arguments.length === 0) return;
        if (method === ADD_ROUTES_METHOD) {
            this.addImplementsFromExpr(call.arguments[0], checker, acc);
            return;
        }
        if (method === RPC_CLIENT_METHOD || method === PUBSUB_CLIENT_METHOD) {
            const info = this.apiInfoFromExpr(call.arguments[0], checker);
            if (info) acc.addUses(info.owner, { api: info.api, type: info.type });
        }
    }

    private addImplementsFromExpr(expr: ts.Expression, checker: ts.TypeChecker, acc: RelationAccumulator): void {
        const info = this.apiInfoFromExpr(expr, checker);
        if (info) acc.addImplements(info.owner, { api: info.api, type: info.type });
    }

    /** Resolve an expression to the API contract it names, or null if it is not one. */
    private apiInfoFromExpr(expr: ts.Expression, checker: ts.TypeChecker): ApiClassInfo | null {
        const decl = resolveClassDeclaration(expr, checker);
        return decl ? this.apiClassInfoFor(decl) : null;
    }

    /** {api, owner, type} when `cls` is an `abstract class` carrying `@ApiPath`, else null. */
    private apiClassInfoFor(cls: ts.ClassDeclaration): ApiClassInfo | null {
        if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return null;
        const owner = this.locator.projectOf(cls.getSourceFile().fileName);
        if (owner === null) return null;
        const type = hasClassDecorator(cls, 'PubSub') ? 'pubsub' : 'rpc';
        return { api: cls.name.text, owner, type };
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
 * Build a program for scanning ONE project. Prefers the project's compile tsconfig; but when that
 * is a solution-style tsconfig (only `references`, no `files`/`include` — e.g. legacy-server), it
 * yields zero files, so we fall back to globbing the project's own `src/**` and reuse the resolved
 * compiler options (which carry tsconfig.base `paths` for cross-package @webpieces resolution).
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
