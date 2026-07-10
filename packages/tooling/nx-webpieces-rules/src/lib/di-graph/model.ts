/**
 * DI Graph Model
 *
 * Data classes for the per-project Inversify dependency DAG that is generated
 * into <projectRoot>/design.json and <projectRoot>/design.md on every build.
 *
 * A project's design.json is a container (`DiGraph`) holding an ARRAY of
 * per-root designs (`DiDesign`) — one self-contained downward tree per
 * @DocumentDesign class (or, for design-root-less library projects, per top-of-DAG
 * class). Each node in a design carries its `level` = BFS depth from that
 * design's root (root = level 0, its direct injections = level 1, and so on).
 *
 * All structures are classes (not interfaces) per the repo convention for
 * data-only structures.
 */

import type * as ts from 'typescript';

export type DiNodeKind =
    | 'controller'
    | 'apiImplementation'
    | 'component'
    | 'class'
    | 'constant'
    | 'dynamic'
    | 'unresolved'
    | 'external'
    // A generated API-client proxy (`createApiClient(SomeApi, ...)` over an
    // @ApiPath contract) — a service/network boundary. Rendered as a leaf; the
    // walk stops here (the remote impl lives in another process, and the client's
    // own transport config, e.g. ClientConfig, is not app architecture).
    | 'api';

export type DiInjectionKind = 'token' | 'type' | 'multiInject';

/**
 * There is no 'unknown'. A class with no explicit `inSingletonScope()` IS transient at runtime:
 * inversify's `DEFAULT_DEFAULT_SCOPE` is Transient and no `new Container(...)` in this workspace
 * overrides `defaultScope`. Reporting 'unknown' hid that fact — and the difference matters,
 * because two arrows into a singleton share one instance while two arrows into a transient do not.
 * Renderers draw transient nodes as a STACK of boxes for exactly that reason.
 */
export type DiScope = 'singleton' | 'transient';

export type BindingKind = 'to' | 'toSelf' | 'toConstantValue' | 'toDynamicValue' | 'decorator';

/**
 * A node in the DI graph — a class, a constant/dynamic binding leaf, or an
 * unresolved token placeholder.
 */
export class DiNode {
    id: string;
    className: string;
    kind: DiNodeKind;
    scope: DiScope;
    file: string;
    /** BFS depth from the design's root (root = 0). Filled in after the walk. */
    level: number;
    /**
     * Secondary detail for constant/dynamic/unresolved leaves whose box is now
     * labeled by the declared param type (see B0): the bound expression text
     * (`toConstantValue`/`toDynamicValue`/`.to(X)` source) or resolving token.
     * Omitted (undefined → not serialized) for class/controller/component nodes.
     */
    detail?: string;
    /**
     * The declared API/interface type this class was injected AS, when it differs
     * from the impl class name — e.g. injected `FirestoreAdminApi`, resolved
     * `.to(FirestoreAdminClient)`. Renderers show it as the primary box label with
     * `className` in parens beneath. Set on first reach; omitted (not serialized)
     * for inject-by-type nodes (declared type == class) and leaves.
     */
    api?: string;

    constructor(
        id: string,
        className: string,
        kind: DiNodeKind,
        scope: DiScope,
        file: string,
        level = 0,
        detail?: string,
    ) {
        this.id = id;
        this.className = className;
        this.kind = kind;
        this.scope = scope;
        this.file = file;
        this.level = level;
        if (detail !== undefined && detail !== '') this.detail = detail;
    }
}

/**
 * A constructor-injection edge: `from` class injects `to` node.
 */
export class DiEdge {
    from: string;
    to: string;
    injection: DiInjectionKind;
    token: string;
    tokenKey: string;
    paramName: string;
    paramType: string;

    constructor(
        from: string,
        to: string,
        injection: DiInjectionKind,
        token: string,
        tokenKey: string,
        paramName: string,
        paramType: string,
    ) {
        this.from = from;
        this.to = to;
        this.injection = injection;
        this.token = token;
        this.tokenKey = tokenKey;
        this.paramName = paramName;
        this.paramType = paramType;
    }
}

/**
 * One self-contained DI design tree: a single root (a @DocumentDesign, or a
 * library top-of-DAG class) and everything it injects "on down". Shared
 * dependencies are duplicated across designs — each design is its own tree so
 * it can be reviewed in isolation.
 */
export class DiDesign {
    /** Node id of this design's root (level 0). */
    root: string;
    rootKind: DiNodeKind;
    /** Workspace-relative posix path of the root class's file. */
    file: string;
    /** Deepest level reached from the root (0 when the root has no injections). */
    maxLevel: number;
    nodes: DiNode[];
    edges: DiEdge[];
    unresolved: string[];

    constructor(root: string, rootKind: DiNodeKind, file: string) {
        this.root = root;
        this.rootKind = rootKind;
        this.file = file;
        this.maxLevel = 0;
        this.nodes = [];
        this.edges = [];
        this.unresolved = [];
    }
}

/**
 * The full per-project DI graph, serialized to design.json — a container over
 * one `DiDesign` per root (controller or library top-of-DAG class).
 */
export class DiGraph {
    schemaVersion: number;
    project: string;
    designs: DiDesign[];

    constructor(project: string) {
        this.schemaVersion = 2;
        this.project = project;
        this.designs = [];
    }
}

/**
 * Canonical identity of a DI token — the key links `Symbol.for('X')` token
 * definitions to their bind() sites even across packages; display is what a
 * human reads in design.md edge labels (e.g. "TYPES.Counter").
 */
export class TokenRef {
    key: string;
    display: string;

    constructor(key: string, display: string) {
        this.key = key;
        this.display = display;
    }
}

/**
 * One binding discovered in pass 1 — either a ContainerModule bind() call or a
 * @provideSingleton/@provideSingletonDefaultForApi/@provideTransient decorator.
 */
export class Binding {
    tokenKey: string;
    tokenDisplay: string;
    kind: BindingKind;
    scope: DiScope;
    /** Implementation class for to/toSelf/decorator bindings; null for constant/dynamic. */
    implClass: ts.ClassDeclaration | null;
    /** Source text of the bound expression for constant/dynamic leaves; '' otherwise. */
    valueText: string;
    /** Workspace-relative posix path of the file the binding appears in. */
    file: string;
    /**
     * Angular `useFactory` deps: the declared `deps: [A, B]` tokens. The walker
     * emits an edge from the dynamic leaf to each dep so a factory's true DI
     * boundary is visible (e.g. ClientConfig's factory → EnvironmentConfig +
     * MutableContextStore). Empty for every Inversify binding.
     */
    factoryDeps: TokenRef[];
    /**
     * True when the bound expression is a `createApiClient(SomeApi, ...)` proxy
     * over an @ApiPath contract. The walker renders this as an `api` boundary
     * leaf and STOPS — it does not expand the factory's `deps` (which are only
     * the client's own transport config, e.g. ClientConfig), matching the way
     * {@link isExternalClass} stops at a published-package boundary.
     */
    isApiBoundary: boolean;

    constructor(
        tokenKey: string,
        tokenDisplay: string,
        kind: BindingKind,
        scope: DiScope,
        implClass: ts.ClassDeclaration | null,
        valueText: string,
        file: string,
        factoryDeps: TokenRef[] = [],
        isApiBoundary = false,
    ) {
        this.tokenKey = tokenKey;
        this.tokenDisplay = tokenDisplay;
        this.kind = kind;
        this.scope = scope;
        this.implClass = implClass;
        this.valueText = valueText;
        this.file = file;
        this.factoryDeps = factoryDeps;
        this.isApiBoundary = isApiBoundary;
    }
}
