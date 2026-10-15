import { ConfigObject } from './rule-pack';

/**
 * Validated owner settings, restricted to the policies supplied by this runtime module.
 *
 * `excludePaths` is the repo's top-level `excludePaths` (webpieces.config.json): globs no rule — build or
 * hook — judges. A runtime applies it, together with each rule's own `excludePaths`, to every file its
 * rules list (#1253); it is passed explicitly so a runtime never re-reads the config to find it.
 */
export class PolicyRuntimeRequest {
    constructor(
        readonly workspaceRoot: string,
        readonly configs: Readonly<Record<string, ConfigObject>>,
        readonly ruleIds: readonly string[],
        readonly excludePaths: readonly string[],
    ) {}
}

export class BuildPolicyResult {
    constructor(readonly success: boolean) {}
}

/** A runtime may supply multiple named checks for one configured policy. */
export interface BuildPolicy {
    readonly name: string;
    readonly configKey: string;
    shouldRun(): boolean;
    run(workspaceRoot: string): Promise<BuildPolicyResult>;
}

export interface BuildRuleRuntime {
    create(request: PolicyRuntimeRequest): Promise<readonly BuildPolicy[]>;
}

export class PolicyDebugSelection {
    constructor(
        readonly rule: string,
        readonly mode: string | undefined,
        readonly projects: string | readonly string[] | undefined,
    ) {}
}

export class BuildDebugRequest {
    constructor(
        readonly workspaceRoot: string,
        readonly selection: PolicyDebugSelection,
    ) {}
}

export interface BuildDebugRuntime {
    run(request: BuildDebugRequest): Promise<BuildPolicyResult>;
}
