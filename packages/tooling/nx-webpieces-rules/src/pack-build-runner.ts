import { BaseRuleConfig, ConfigObject, BuildPolicyResult } from '@webpieces/rules-sdk';
import {
    AbstractRule,
    LoadedConfig,
    NodeRuleRuntimeModuleLoader,
    RuleRuntimeModules,
    RuntimeContributionGroup,
    renderRuleFailForHuman,
    RuleFailError,
} from '@webpieces/rules-config';
import { toError } from './toError';
import { rulePackManifest } from './rule-pack';

class BuildActivation extends AbstractRule<BaseRuleConfig> {}

/** Native checks retain their targets; one generic target runs other declared build providers. */
export class PackBuildRunner {
    async run(root: string, loaded: LoadedConfig): Promise<BuildPolicyResult> {
        const modules = new RuleRuntimeModules(),
            loader = new NodeRuleRuntimeModuleLoader(root);
        let success = true;
        const groups = modules
            .groups(loaded.ruleRegistry, 'build')
            .filter(
                (group: RuntimeContributionGroup) =>
                    group.providerPack !== rulePackManifest.packageName,
            );
        for (const group of groups) {
            const request = modules.request(
                root,
                loaded.rulesConfig as Record<string, ConfigObject>,
                group,
            );
            const exports = modules.load(group, loaded.ruleRegistry.manifestModules, loader);
            const checks = await modules.createBuildPolicies(exports, request);
            for (const check of checks) {
                const activation = new BuildActivation(
                    request.configs[check.configKey] as BaseRuleConfig,
                    check.name,
                    check.configKey,
                );
                if (!activation.shouldRun() || !check.shouldRun()) continue;
                // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- isolate checks and preserve human-facing policy failures
                try {
                    const result = await check.run(root);
                    if (!result || result.success !== true) success = false;
                // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
                } catch (err: unknown) {
                    const error = toError(err);
                    console.error(
                        error instanceof RuleFailError
                            ? renderRuleFailForHuman(error)
                            : `Build policy ${check.name} failed: ${error.message}`,
                    );
                    success = false;
                }
            }
        }
        return new BuildPolicyResult(success);
    }
}
