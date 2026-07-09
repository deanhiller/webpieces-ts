/**
 * DI Graph Analyzer (pass 2)
 *
 * Walks constructor injection from a project's root classes down to leaves:
 *
 *   - @inject(TOKEN) params    → token lookup in the binding table → bound impl
 *   - @multiInject(TOKEN)      → fan-out edge to EVERY binding of that token
 *   - bare typed params        → checker resolves the type to a class (inject-by-type)
 *   - toConstantValue/toDynamicValue bindings → leaf nodes, no recursion
 *   - unresolvable tokens/types → kind "unresolved" nodes (generation never fails)
 *
 * Roots: @DocumentDesign() classes when the project has any; otherwise every
 * DI-registered class in the project that no other project class injects
 * (the tops of the local DAG).
 */

import * as ts from 'typescript';
import * as path from 'path';
import { Binding, DiDesign, DiEdge, DiGraph, DiNode, DiNodeKind, DiScope } from './model';
import {
    BindingTable,
    classDecorators,
    collectBindings,
    decoratorCall,
    decoratorName,
    isExternalClass,
    resolveClassDeclaration,
} from './bindings';
import { classTokenKey, relativeFile, resolveTokenKey } from './token-resolver';

const DI_DECORATORS = new Set([
    'provideSingleton',
    'provideTransient',
    'provideSingletonAs',
    'provideFrameworkSingleton',
    'provideFrameworkSingletonAs',
    'provideFrameworkTransient',
    'injectable',
]);

export class ParamInjection {
    expr: ts.Expression | null;
    multi: boolean;
    optional: boolean;
    unmanaged: boolean;

    constructor(expr: ts.Expression | null, multi: boolean, optional: boolean, unmanaged: boolean) {
        this.expr = expr;
        this.multi = multi;
        this.optional = optional;
        this.unmanaged = unmanaged;
    }
}

export function readParamDecorators(param: ts.ParameterDeclaration): ParamInjection {
    let expr: ts.Expression | null = null;
    let multi = false;
    let optional = false;
    let unmanaged = false;
    for (const decorator of ts.getDecorators(param) ?? []) {
        const name = decoratorName(decorator);
        const call = decoratorCall(decorator);
        if (name === 'inject' && call?.arguments[0]) {
            expr = call.arguments[0];
        } else if (name === 'multiInject' && call?.arguments[0]) {
            expr = call.arguments[0];
            multi = true;
        } else if (name === 'optional') {
            optional = true;
        } else if (name === 'unmanaged') {
            unmanaged = true;
        }
    }
    return new ParamInjection(expr, multi, optional, unmanaged);
}

function hasDecoratorNamed(cls: ts.ClassDeclaration, names: Set<string>): boolean {
    for (const decorator of classDecorators(cls)) {
        const name = decoratorName(decorator);
        if (name && names.has(name)) return true;
    }
    return false;
}

/** A `@DocumentDesign` class — the explicit DI-design root (server controller or designed-lib impl). */
export function isDocumentDesignClass(cls: ts.ClassDeclaration): boolean {
    return hasDecoratorNamed(cls, new Set(['DocumentDesign']));
}

/**
 * The node kind for a `@DocumentDesign` root, chosen by the analyzer's root mode
 * rather than the decorator (a single `@DocumentDesign` marks both). `server` →
 * `controller`, `designed-lib` → `apiImplementation`.
 */
export type DiRootMode = 'controller' | 'apiImplementation';

export function rootKindForMode(mode: DiRootMode): DiNodeKind {
    return mode === 'apiImplementation' ? 'apiImplementation' : 'controller';
}

function isDiRegisteredClass(cls: ts.ClassDeclaration): boolean {
    return hasDecoratorNamed(cls, DI_DECORATORS);
}

export function findConstructor(cls: ts.ClassDeclaration): ts.ConstructorDeclaration | null {
    for (const member of cls.members) {
        if (ts.isConstructorDeclaration(member) && member.body) return member;
        if (ts.isConstructorDeclaration(member)) return member;
    }
    return null;
}

/** All class declarations in files under the project root. */
export function projectClasses(
    program: ts.Program,
    workspaceRoot: string,
    projectRoot: string,
): ts.ClassDeclaration[] {
    const prefix = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
    const classes: ts.ClassDeclaration[] = [];
    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        const rel = relativeFile(workspaceRoot, sourceFile);
        if (!rel.startsWith(prefix)) continue;
        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) classes.push(node);
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    return classes;
}

/**
 * One normalized injection site, framework-agnostic — produced by a builder's
 * `collectInjections(cls)` hook and processed by the shared base. Inversify
 * emits `token`/`type` from constructor params; Angular emits `angularToken`
 * from constructor params AND `inject()` field initializers.
 *
 * Modes:
 *   - `token`        Inversify `@inject`/`@multiInject`: table lookup; an unbound
 *                    token becomes an `unresolved` node (no class fallback).
 *   - `type`         Inversify bare typed param: resolve the declared TYPE to a
 *                    class (inject-by-type); no table lookup.
 *   - `angularToken` Angular `inject(T)` / `@Inject(T)` / bare typed ctor param:
 *                    table lookup FIRST (provider table), then fall back to
 *                    resolving the token expression as a class, else unresolved.
 */
export class Injection {
    mode: 'token' | 'type' | 'angularToken';
    /** Token/type expression (modes `token`/`angularToken`, or the type identifier for `type`). */
    expr: ts.Expression | ts.Identifier | null;
    multi: boolean;
    optional: boolean;
    paramName: string;
    paramType: string;

    constructor(
        mode: 'token' | 'type' | 'angularToken',
        expr: ts.Expression | ts.Identifier | null,
        paramName: string,
        paramType: string,
        multi = false,
        optional = false,
    ) {
        this.mode = mode;
        this.expr = expr;
        this.paramName = paramName;
        this.paramType = paramType;
        this.multi = multi;
        this.optional = optional;
    }
}

/**
 * Builds ONE self-contained `DiDesign` for a single root. A fresh instance is
 * created per root so its maps (visited/classIds/usedIds/...) are scoped to
 * that root's tree — a dependency shared by two roots is therefore walked
 * (and duplicated) into each root's design, not hidden under whichever root
 * reached it first.
 *
 * Framework-agnostic base: subclasses implement {@link collectInjections} (and
 * override {@link rootKindOf} for Angular components); everything else — node
 * ids, leaf/unresolved labeling, token→binding resolution, factory-dep edges,
 * level assignment — is shared so Inversify and Angular render identically.
 */
export abstract class DiDesignBuilder {
    protected readonly checker: ts.TypeChecker;
    protected readonly table: BindingTable;
    protected readonly workspaceRoot: string;
    protected readonly design: DiDesign;
    private readonly classIds = new Map<ts.ClassDeclaration, string>();
    private readonly leafIds = new Map<Binding, string>();
    private readonly unresolvedIds = new Map<string, string>();
    private readonly usedIds = new Set<string>();
    private readonly visited = new Set<ts.ClassDeclaration>();
    protected rootClass: ts.ClassDeclaration | null = null;

    constructor(checker: ts.TypeChecker, table: BindingTable, workspaceRoot: string, design: DiDesign) {
        this.checker = checker;
        this.table = table;
        this.workspaceRoot = workspaceRoot;
        this.design = design;
    }

    /** Collect the injection sites for one class (constructor params, field inject(), ...). */
    protected abstract collectInjections(cls: ts.ClassDeclaration): Injection[];

    /**
     * Node kind for a root/reached class. Default: the ROOT box takes the design's
     * `rootKind` (`controller`/`apiImplementation`, chosen by root mode); every
     * reached dependency is a plain `class`. Angular overrides this to render
     * component classes as `component`.
     */
    protected rootKindOf(cls: ts.ClassDeclaration): DiNodeKind {
        return cls === this.rootClass ? this.design.rootKind : 'class';
    }

    addRoot(cls: ts.ClassDeclaration): void {
        this.rootClass = cls;
        const id = this.classNode(cls);
        this.design.root = id;
        this.walkClass(cls);
    }

    /**
     * Register (or fetch) the node for a class, returning its stable id.
     * `scopeHint` carries the scope of the module binding the class was reached
     * through (e.g. bind(TOKEN).to(X).inSingletonScope() where X is not self-bound).
     * `apiType` is the declared param/field type the class was injected as; when it
     * differs from the impl class name it becomes the node's `api` (rendered as the
     * primary box label, with the impl class in parens). Set on first reach.
     */
    protected classNode(cls: ts.ClassDeclaration, scopeHint: DiScope = 'transient', apiType = ''): string {
        const existing = this.classIds.get(cls);
        if (existing) return existing;

        const className = cls.name ? cls.name.text : '<anonymous>';
        const file = relativeFile(this.workspaceRoot, cls.getSourceFile());
        const id = this.claimId(className, file);
        this.classIds.set(cls, id);

        // The class's OWN binding wins; otherwise the scope of the module binding it was reached
        // through; otherwise transient (inversify's default scope).
        const scope = this.classScope(cls) ?? scopeHint;
        // A class from a published package (resolved to a .d.ts under node_modules)
        // is a boundary leaf: shown so the dependency is visible, but never expanded
        // (walkClass stops there). Roots are always project classes, so this never
        // relabels a root.
        const kind: DiNodeKind = isExternalClass(cls) ? 'external' : this.rootKindOf(cls);
        const node = new DiNode(id, className, kind, scope, file);
        // Injected AS an API/interface that resolves to a differently-named impl —
        // record the contract (strip a trailing `[]` from multiInject array params).
        const api = apiType.replace(/\[\]$/, '');
        if (api !== '' && api !== className) node.api = api;
        this.design.nodes.push(node);
        return id;
    }

    private claimId(preferred: string, file: string): string {
        if (!this.usedIds.has(preferred)) {
            this.usedIds.add(preferred);
            return preferred;
        }
        const disambiguated = `${preferred}@${path.posix.dirname(file)}`;
        let id = disambiguated;
        let n = 2;
        while (this.usedIds.has(id)) {
            id = `${disambiguated}~${n}`;
            n++;
        }
        this.usedIds.add(id);
        return id;
    }

    /** Scope from the class's own decorator/module binding, or undefined if it has none. */
    private classScope(cls: ts.ClassDeclaration): DiScope | undefined {
        const token = classTokenKey(cls, this.workspaceRoot);
        for (const binding of this.table.lookup(token.key)) {
            return binding.scope;
        }
        return undefined;
    }

    /**
     * Leaf box for a constant/dynamic binding. B0: the box is labeled by the
     * DECLARED param TYPE (e.g. `FirestoreConfig`, `ClientConfig`) — the DI
     * contract — while the bound expression (`buildConfigFromEnv(...)` /
     * `TOKEN (dynamic)`) is kept as `detail`. A dynamic leaf also fans out to
     * each of its `useFactory` `deps` (Angular; empty for Inversify).
     */
    private leafNode(binding: Binding, kind: DiNodeKind, paramType: string): string {
        const existing = this.leafIds.get(binding);
        if (existing) return existing;

        const detail = kind === 'dynamic' ? `${binding.tokenDisplay} (dynamic)` : binding.valueText;
        const className = paramType !== '' ? paramType : detail !== '' ? detail : binding.tokenDisplay;
        const id = this.claimId(className, binding.file);
        this.leafIds.set(binding, id);
        this.design.nodes.push(new DiNode(id, className, kind, binding.scope, binding.file, 0, detail));
        if (kind === 'dynamic') this.expandFactoryDeps(id, binding);
        return id;
    }

    /** Edges from a `useFactory` leaf to each declared `deps: [...]` token (Angular). */
    private expandFactoryDeps(leafId: string, binding: Binding): void {
        for (const dep of binding.factoryDeps) {
            const bindings = this.table.lookup(dep.key);
            if (bindings.length > 0) {
                for (const depBinding of bindings) {
                    // The dep token IS the declared type — label the box with it.
                    const toId = this.bindingTarget(depBinding, dep.display);
                    this.design.edges.push(new DiEdge(leafId, toId, 'type', dep.display, dep.key, dep.display, dep.display));
                }
            } else {
                const toId = this.unresolvedNode(dep.display, binding.file, '');
                this.design.edges.push(new DiEdge(leafId, toId, 'type', dep.display, dep.key, dep.display, dep.display));
            }
        }
    }

    /**
     * `unresolved` placeholder box. B0: labeled by the declared param TYPE
     * (`className`) with the resolving token expression kept as `detail` (and
     * surfaced in `design.unresolved` for diagnostics).
     */
    private unresolvedNode(className: string, file: string, detail: string): string {
        const key = `${className}|${detail}|${file}`;
        const existing = this.unresolvedIds.get(key);
        if (existing) return existing;

        const id = this.claimId(className, file);
        this.unresolvedIds.set(key, id);
        this.design.nodes.push(new DiNode(id, className, 'unresolved', 'transient', file, 0, detail !== className ? detail : ''));
        this.design.unresolved.push(detail !== '' ? detail : className);
        return id;
    }

    protected walkClass(cls: ts.ClassDeclaration): void {
        if (this.visited.has(cls)) return;
        this.visited.add(cls);

        // External boundary: the node is already registered by the caller's
        // classNode() (kind 'external'); we intentionally do NOT descend into a
        // published package's internals (e.g. an SDK Client's ClientOptions/impl).
        if (isExternalClass(cls)) return;

        const fromId = this.classNode(cls);
        for (const injection of this.collectInjections(cls)) {
            this.processInjection(fromId, cls, injection);
        }
        this.expandProviderTarget(fromId, cls);
    }

    /**
     * A Provider subclass has no constructor injections of its own — it holds a resolve-lambda.
     * Draw the class it hands out beneath it, so the design shows `Factory -> XProvider -> X`
     * rather than stopping at the provider. X's own scope then decides the glyph: one box for a
     * lazy singleton, a stack for a fresh-instance-per-get().
     */
    private expandProviderTarget(fromId: string, cls: ts.ClassDeclaration): void {
        const token = classTokenKey(cls, this.workspaceRoot);
        const target = this.table.providerTarget(token.key);
        if (!target) return;

        const targetToken = classTokenKey(target, this.workspaceRoot);
        const toId = this.classNode(target);
        this.walkClass(target);
        this.design.edges.push(
            new DiEdge(fromId, toId, 'type', targetToken.display, targetToken.key, 'get()', target.name?.text ?? ''),
        );
    }

    /** Resolve one injection to a node and record the edge(s). Never throws. */
    private processInjection(fromId: string, cls: ts.ClassDeclaration, injection: Injection): void {
        if (injection.mode === 'type') {
            this.processTypeInjection(fromId, cls, injection);
        } else {
            this.processTokenInjection(fromId, cls, injection);
        }
    }

    /** Inversify `@inject`/`@multiInject` and Angular `inject()`/`@Inject`/bare token. */
    private processTokenInjection(fromId: string, cls: ts.ClassDeclaration, injection: Injection): void {
        const expr = injection.expr;
        if (!expr) return;
        const token = resolveTokenKey(expr, this.checker, this.workspaceRoot);
        const kind = injection.multi ? 'multiInject' : 'token';
        const bindings = this.table.lookup(token.key);

        if (bindings.length > 0) {
            for (const binding of bindings) {
                const toId = this.bindingTarget(binding, injection.paramType);
                this.design.edges.push(
                    new DiEdge(fromId, toId, kind, token.display, token.key, injection.paramName, injection.paramType),
                );
            }
            return;
        }

        // @multiInject @optional with zero bindings is legal — no edge, no error.
        if (injection.multi && injection.optional) return;

        // Angular: a token with no explicit provider may still be a bare @Injectable
        // class — resolve the token expression as a class and inject it by type.
        if (injection.mode === 'angularToken') {
            const target = resolveClassDeclaration(expr, this.checker);
            if (target) {
                const classToken = classTokenKey(target, this.workspaceRoot);
                const toId = this.classNode(target, 'transient', injection.paramType);
                this.walkClass(target);
                this.design.edges.push(
                    new DiEdge(fromId, toId, 'type', classToken.display, classToken.key, injection.paramName, injection.paramType),
                );
                return;
            }
        }

        const file = relativeFile(this.workspaceRoot, cls.getSourceFile());
        const label = injection.paramType !== '' ? injection.paramType : token.display;
        const toId = this.unresolvedNode(label, file, token.display);
        this.design.edges.push(
            new DiEdge(fromId, toId, kind, token.display, token.key, injection.paramName, injection.paramType),
        );
    }

    private bindingTarget(binding: Binding, paramType: string): string {
        if (binding.implClass) {
            const toId = this.classNode(binding.implClass, binding.scope, paramType);
            this.walkClass(binding.implClass);
            return toId;
        }
        if (binding.kind === 'toConstantValue') return this.leafNode(binding, 'constant', paramType);
        if (binding.kind === 'toDynamicValue') return this.leafNode(binding, 'dynamic', paramType);
        // .to(X) where X did not resolve to a class declaration.
        const detail = binding.valueText !== '' ? binding.valueText : binding.tokenDisplay;
        const label = paramType !== '' ? paramType : detail;
        return this.unresolvedNode(label, binding.file, detail);
    }

    /** Inversify bare typed param — resolve the declared type directly to a class. */
    private processTypeInjection(fromId: string, cls: ts.ClassDeclaration, injection: Injection): void {
        const typeRef = injection.expr && ts.isIdentifier(injection.expr) ? injection.expr : null;
        const target = typeRef ? resolveClassDeclaration(typeRef, this.checker) : null;

        if (target) {
            const token = classTokenKey(target, this.workspaceRoot);
            const toId = this.classNode(target);
            this.walkClass(target);
            this.design.edges.push(
                new DiEdge(fromId, toId, 'type', token.display, token.key, injection.paramName, injection.paramType),
            );
            return;
        }

        // Bare param whose type is not a resolvable class (interface, primitive, etc.).
        const file = relativeFile(this.workspaceRoot, cls.getSourceFile());
        const label = injection.paramType !== '' ? injection.paramType : injection.paramName;
        const toId = this.unresolvedNode(label, file, '');
        this.design.edges.push(
            new DiEdge(fromId, toId, 'type', injection.paramType, `type:${injection.paramType}`, injection.paramName, injection.paramType),
        );
    }
}

/**
 * Inversify builder: injection sites are constructor params — `@inject`/
 * `@multiInject` tokens or bare typed (inject-by-type) params.
 */
export class InversifyDesignBuilder extends DiDesignBuilder {
    protected collectInjections(cls: ts.ClassDeclaration): Injection[] {
        const ctor = findConstructor(cls);
        if (!ctor) return [];

        const injections: Injection[] = [];
        for (const param of ctor.parameters) {
            const decorated = readParamDecorators(param);
            if (decorated.unmanaged) continue;

            const paramName = ts.isIdentifier(param.name) ? param.name.text : param.name.getText();
            const paramType = param.type ? param.type.getText() : '';

            if (decorated.expr) {
                injections.push(
                    new Injection('token', decorated.expr, paramName, paramType, decorated.multi, decorated.optional),
                );
            } else {
                const typeRef =
                    param.type && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName)
                        ? param.type.typeName
                        : null;
                injections.push(new Injection('type', typeRef, paramName, paramType));
            }
        }
        return injections;
    }
}

export function byClassName(a: ts.ClassDeclaration, b: ts.ClassDeclaration): number {
    const nameA = a.name ? a.name.text : '';
    const nameB = b.name ? b.name.text : '';
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return a.getSourceFile().fileName < b.getSourceFile().fileName ? -1 : 1;
}

/**
 * Library-project roots: DI-registered classes in the project that no other
 * project class injects (tops of the local DAG).
 */
function findLibraryRoots(
    classes: ts.ClassDeclaration[],
    checker: ts.TypeChecker,
    table: BindingTable,
    workspaceRoot: string,
): ts.ClassDeclaration[] {
    const diClasses = classes.filter((cls: ts.ClassDeclaration) => isDiRegisteredClass(cls));
    const injected = new Set<ts.ClassDeclaration>();

    for (const cls of diClasses) {
        const ctor = findConstructor(cls);
        for (const param of ctor?.parameters ?? []) {
            const injection = readParamDecorators(param);
            if (injection.unmanaged) continue;
            if (injection.expr) {
                const token = resolveTokenKey(injection.expr, checker, workspaceRoot);
                for (const binding of table.lookup(token.key)) {
                    if (binding.implClass) injected.add(binding.implClass);
                }
            } else if (param.type && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName)) {
                const target = resolveClassDeclaration(param.type.typeName, checker);
                if (target) injected.add(target);
            }
        }
    }

    return diClasses.filter((cls: ts.ClassDeclaration) => !injected.has(cls));
}

/**
 * Assign each node its LONGEST-path depth from the design's root (root = level
 * 0, its direct injections = level 1, ...) and record the deepest level. A node
 * reached from multiple parents takes its DEEPEST depth, so it always sits below
 * everything that depends on it (a dependency is never on the same or a shallower
 * level than its dependent — e.g. a config injected by both a level-2 service and
 * a level-3 client lands at level 4, one below that client). Levels are computed
 * by edge relaxation bounded by the reachable node count, which terminates even
 * if the DI graph contains a cycle; the root is pinned at 0.
 */
export function assignLevels(design: DiDesign): void {
    const outgoing = new Map<string, string[]>();
    for (const e of design.edges) {
        const list = outgoing.get(e.from) ?? [];
        list.push(e.to);
        outgoing.set(e.from, list);
    }

    // Nodes reachable from the root — only these get a level; the rest fall back
    // to 0 below, matching the previous behaviour for disconnected nodes.
    const reachable = new Set<string>();
    const queue = [design.root];
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        if (reachable.has(id)) continue;
        reachable.add(id);
        for (const to of outgoing.get(id) ?? []) {
            if (!reachable.has(to)) queue.push(to);
        }
    }

    const levelById = new Map<string, number>();
    for (const id of reachable) levelById.set(id, 0);
    // Bellman-Ford-style longest-path relaxation. |reachable| passes suffice for
    // any acyclic graph; the pass count also bounds work if a cycle exists.
    for (let pass = 0; pass < reachable.size; pass++) {
        let changed = false;
        for (const e of design.edges) {
            if (!reachable.has(e.from) || e.to === design.root) continue;
            const candidate = (levelById.get(e.from) ?? 0) + 1;
            if (candidate > (levelById.get(e.to) ?? 0)) {
                levelById.set(e.to, candidate);
                changed = true;
            }
        }
        if (!changed) break;
    }

    let maxLevel = 0;
    for (const node of design.nodes) {
        node.level = levelById.get(node.id) ?? 0;
        if (node.level > maxLevel) maxLevel = node.level;
    }
    design.maxLevel = maxLevel;
}

/**
 * Build one self-contained downward design tree for a single root class, using
 * the builder produced by `makeBuilder` (Inversify or Angular). `rootKind` is
 * the node kind for the root box (`controller`/`component`/`class`).
 */
export function buildDesign(
    root: ts.ClassDeclaration,
    rootKind: DiNodeKind,
    workspaceRoot: string,
    makeBuilder: (design: DiDesign) => DiDesignBuilder,
): DiDesign {
    const className = root.name ? root.name.text : '<anonymous>';
    const file = relativeFile(workspaceRoot, root.getSourceFile());
    const design = new DiDesign(className, rootKind, file);
    makeBuilder(design).addRoot(root);
    assignLevels(design);
    return design;
}

/**
 * Build the full Inversify DI graph for one project: one self-contained
 * `DiDesign` per @DocumentDesign root. `projectRoot` is workspace-relative.
 *
 * Both `rootMode`s root on @DocumentDesign classes; the mode only sets the root
 * box kind (`'controller'` for server, `'apiImplementation'` for designed-lib).
 * `includeLibraryRoots` (default false) lets a project with NO @DocumentDesign
 * class fall back to top-of-DAG DI classes (rendered as plain `class` roots).
 */
export function buildDiGraph(
    program: ts.Program,
    workspaceRoot: string,
    projectRoot: string,
    projectName: string,
    includeLibraryRoots = false,
    rootMode: DiRootMode = 'controller',
): DiGraph {
    const checker = program.getTypeChecker();
    const table = collectBindings(program, checker, workspaceRoot);
    const graph = new DiGraph(projectName);

    const classes = projectClasses(program, workspaceRoot, projectRoot);
    const designRoots = classes.filter((cls: ts.ClassDeclaration) => isDocumentDesignClass(cls));
    // Both modes root on @DocumentDesign classes. In controller mode a project with
    // no explicit design root may fall back to top-of-DAG DI classes (those render
    // as plain `class` roots, preserving prior behaviour).
    const roots =
        designRoots.length > 0
            ? designRoots
            : rootMode === 'controller' && includeLibraryRoots
              ? findLibraryRoots(classes, checker, table, workspaceRoot)
              : [];

    for (const root of [...roots].sort(byClassName)) {
        const rootKind: DiNodeKind = isDocumentDesignClass(root) ? rootKindForMode(rootMode) : 'class';
        graph.designs.push(
            buildDesign(
                root,
                rootKind,
                workspaceRoot,
                (design: DiDesign) => new InversifyDesignBuilder(checker, table, workspaceRoot, design),
            ),
        );
    }

    return graph;
}
