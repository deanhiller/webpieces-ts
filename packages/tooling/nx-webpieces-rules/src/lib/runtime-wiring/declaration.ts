import type { ApiTransport, ExternalSystemDeclaration } from '../api-usage/api-relations';

/** Stable source identity. Equal class shapes or short names never establish API identity. */
export class ContractIdentity {
    constructor(
        public readonly project: string,
        public readonly exportedName: string,
    ) {}
}

export type DeclaredTarget =
    | { kind: 'service'; service: string; contract?: ContractIdentity }
    | { kind: 'parameter'; parameter: string }
    | { kind: 'external'; system: ExternalSystemDeclaration }
    | { kind: 'unknown'; reason: string };

export class ImplementsFacts {
    readonly direction = 'implements';
    declare readonly target?: never;
    constructor(
        public readonly transport: ApiTransport,
        public readonly policy?: string,
    ) {}
}

export class UsesFacts {
    readonly direction = 'uses';
    constructor(
        public readonly transport: ApiTransport,
        public readonly target: DeclaredTarget,
        public readonly policy?: string,
    ) {}
}

export type WiringFacts = ImplementsFacts | UsesFacts;

export class WiringRelationship {
    readonly direction: 'implements' | 'uses';
    readonly transport: ApiTransport;
    readonly target?: DeclaredTarget;
    readonly policy?: string;

    constructor(
        public readonly contract: ContractIdentity,
        facts: WiringFacts,
    ) {
        this.direction = facts.direction;
        this.transport = facts.transport;
        this.target = facts.direction === 'uses' ? facts.target : undefined;
        this.policy = facts.policy;
    }
}

/** Only these exports execute, in this order, with these graph-relevant arguments. */
export class WiringSelection {
    constructor(
        public readonly project: string,
        public readonly exportedName: string,
        public readonly targets: Record<string, DeclaredTarget>,
        public readonly policies: Record<string, PolicyValue>,
    ) {}
}

export type PolicyValue = boolean | 'runtime' | { parameter: string };

export class WiringExport {
    constructor(
        public readonly kind: 'binding' | 'routing' | 'wiring' | 'app' | 'external',
        public readonly relationships: WiringRelationship[],
        public readonly bindModules: WiringSelection[],
        public readonly routeModules: WiringSelection[] = [],
        public readonly wirings: WiringSelection[] = [],
    ) {}
}

/** No timestamps, machine paths, credentials, deployment URLs, or cache keys belong here. */
export class RuntimeDeclaration {
    declare readonly schemaVersion: 2;
    declare readonly project: string;
    declare readonly framework: 'node' | 'angular' | 'browser';
    declare readonly exports: Record<string, WiringExport>;
    declare readonly entry?: string;
    declare readonly host?: string;

    constructor(
        project: string,
        framework: 'node' | 'angular' | 'browser',
        exports: Record<string, WiringExport>,
        entry?: string,
        host?: string,
    ) {
        this.schemaVersion = 2;
        this.project = project;
        this.framework = framework;
        this.exports = exports;
        this.entry = entry;
        this.host = host;
    }
}
