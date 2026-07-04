/**
 * DI Graph Model
 *
 * Data classes for the per-project Inversify dependency DAG that is generated
 * into <projectRoot>/design.json and <projectRoot>/design.md on every build.
 *
 * All structures are classes (not interfaces) per the repo convention for
 * data-only structures.
 */

import type * as ts from 'typescript';

export type DiNodeKind = 'controller' | 'class' | 'constant' | 'dynamic' | 'unresolved';

export type DiInjectionKind = 'token' | 'type' | 'multiInject';

export type DiScope = 'singleton' | 'transient' | 'unknown';

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

    constructor(id: string, className: string, kind: DiNodeKind, scope: DiScope, file: string) {
        this.id = id;
        this.className = className;
        this.kind = kind;
        this.scope = scope;
        this.file = file;
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
 * The full per-project DI graph, serialized to design.json.
 */
export class DiGraph {
    schemaVersion: number;
    project: string;
    roots: string[];
    nodes: DiNode[];
    edges: DiEdge[];
    unresolved: string[];

    constructor(project: string) {
        this.schemaVersion = 1;
        this.project = project;
        this.roots = [];
        this.nodes = [];
        this.edges = [];
        this.unresolved = [];
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
 * @provideSingleton/@provideSingletonAs/@provideTransient decorator.
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

    constructor(
        tokenKey: string,
        tokenDisplay: string,
        kind: BindingKind,
        scope: DiScope,
        implClass: ts.ClassDeclaration | null,
        valueText: string,
        file: string,
    ) {
        this.tokenKey = tokenKey;
        this.tokenDisplay = tokenDisplay;
        this.kind = kind;
        this.scope = scope;
        this.implClass = implClass;
        this.valueText = valueText;
        this.file = file;
    }
}
