import type { ExecutorContext } from '@nx/devkit';
import { BuildPolicyResult } from '@webpieces/rules-sdk';

/** Native owner actions are shared where one existing scan enforces several configured policies. */
export class NativeAction {
    constructor(
        readonly name: string,
        readonly scope: 'workspace' | 'projects',
        readonly execute: (context: ExecutorContext) => Promise<BuildPolicyResult>,
    ) {}
}

/** Metadata holds lazy imports only; importing the pack never imports an executor or the Nx runtime. */
export class NativeActions {
    readonly wiringFormat = new NativeAction('wiring-format', 'workspace', async (context: ExecutorContext) => {
        const format = await import('./lib/runtime-wiring/workspace-format');
        const metadata = await import('./lib/graph-metadata');
        new format.WorkspaceWiringFormat().run(context.root, await metadata.collectProjectInfo());
        return new BuildPolicyResult(true);
    });
    readonly fileCycles = new NativeAction(
        'file-cycles',
        'projects',
        async (context: ExecutorContext) =>
            (await import('./executors/validate-no-file-import-cycles/executor')).default(
                {},
                context,
            ),
    );
    readonly runtime = new NativeAction('runtime', 'workspace', async (context: ExecutorContext) =>
        (await import('./executors/validate-runtime-architecture/executor')).default({}, context),
    );
    readonly wiring = new NativeAction('wiring', 'workspace', async (context: ExecutorContext) =>
        (await import('./executors/validate-nx-wiring/executor')).default({}, context),
    );
    readonly design = new NativeAction('design', 'projects', async (context: ExecutorContext) =>
        (await import('./executors/di-graph-generate/executor')).default({}, context),
    );
    readonly architecture = new NativeAction(
        'architecture',
        'workspace',
        async (context: ExecutorContext) =>
            (await import('./executors/validate-architecture-unchanged/executor')).default(
                {},
                context,
            ),
    );
    readonly cycles = new NativeAction('cycles', 'workspace', async (context: ExecutorContext) =>
        (await import('./executors/validate-no-architecture-cycles/executor')).default({}, context),
    );
    readonly packageJson = new NativeAction(
        'package-json',
        'workspace',
        async (context: ExecutorContext) =>
            (await import('./executors/validate-packagejson/executor')).default({}, context),
    );
    readonly versions = new NativeAction(
        'versions',
        'workspace',
        async (context: ExecutorContext) =>
            (await import('./executors/validate-versions-locked/executor')).default({}, context),
    );
    readonly eslintSync = new NativeAction(
        'eslint-sync',
        'workspace',
        async (context: ExecutorContext) =>
            (await import('./executors/validate-eslint-sync/executor')).default({}, context),
    );
    readonly tsInSrc = new NativeAction(
        'ts-in-src',
        'workspace',
        async (context: ExecutorContext) =>
            (await import('./executors/validate-ts-in-src/executor')).default({}, context),
    );
    readonly graphPolicies = new NativeAction(
        'graph-policies',
        'workspace',
        async (context: ExecutorContext) => {
            const graph = await import('./executors/validate-architecture-unchanged/executor');
            await new graph.CurrentGraphBuilder().build(context.root);
            return new BuildPolicyResult(true);
        },
    );
}
