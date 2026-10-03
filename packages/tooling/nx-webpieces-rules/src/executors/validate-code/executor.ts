import type { ExecutorContext } from '@nx/devkit';
import { BuildDebugRequest, PolicyDebugSelection } from '@webpieces/rules-sdk';
import {
    loadAndValidate,
    NodeRuleRuntimeModuleLoader,
    RuleRuntimeModules,
    RuntimeContributionGroup,
} from '@webpieces/rules-config';
import { RuleFailError } from '@webpieces/rules-config';
import { PackBuildRunner } from '../../pack-build-runner';
import { ExecutorResult } from '../../executor-result';

/** Runtime policy options come only from validated owner files. These flags request one ephemeral debug run. */
export class ValidateCodeOptions {
    rule?: string;
    mode?: string;
    projects?: string | string[];
}

// webpieces-disable no-function-outside-class -- Nx's required public executor entry point
export default async function runExecutor(
    options: ValidateCodeOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const loaded = loadAndValidate(context.root);
    if (loaded.configPath === null)
        throw new RuleFailError(
            'policy-configuration',
            'Missing webpieces.config.json. Configure explicit rulePacks before running build policies.',
        );
    if (
        options.rule === undefined &&
        options.mode === undefined &&
        options.projects === undefined
    ) {
        return new PackBuildRunner().run(context.root, loaded);
    }
    if (options.rule === undefined)
        throw new RuleFailError(
            'policy-configuration',
            '--mode and --projects require --rule=<name>: a debug run judges exactly one rule.',
        );
    const modules = new RuleRuntimeModules();
    const group = modules
        .groups(loaded.ruleRegistry, 'build')
        .find((entry: RuntimeContributionGroup) => entry.ruleIds.includes(options.rule!));
    if (!group)
        throw new RuleFailError(
            'policy-configuration',
            `No declared build contribution for ${options.rule}. Use a rule from the generated policy catalog.`,
        );
    const exports = modules.load(
        group,
        loaded.ruleRegistry.manifestModules,
        new NodeRuleRuntimeModuleLoader(context.root),
    );
    return modules.runBuildDebug(
        exports,
        new BuildDebugRequest(
            context.root,
            new PolicyDebugSelection(options.rule, options.mode, options.projects),
        ),
    );
}
