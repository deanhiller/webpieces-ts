import * as path from 'node:path';
import { injectable, bindingScopeValues } from 'inversify';
import { ConfigObject } from '@webpieces/rules-sdk';
import { InformAiError, AtomicFile } from '@webpieces/tooling-common';
import { buildCommandsConfig, CommandsConfig } from './commands-config';
import { ConfigFile } from './config-file';
import { RulePackRegistry } from './rule-pack-registry';
import { PackPolicyFiles, PackPolicyFilesResult } from './pack-policy-files';
import { RulePackArtifacts } from './rule-pack-artifacts';
import { ExcludePaths } from './exclude-hook-paths';
import { PrGateConfig } from './pr-gate-config';
import { ResolvedConfig, ResolvedRuleConfig } from './types';
import { validateCommandsSection } from './commands-section-validators';
import { validateTopLevelKeys } from './config-key-rules';
import { validateExcludePaths, validateMatchRulesSection } from './validate-config';
import { MatchRuleConfig } from './match-rules-config';
import { WebpiecesRulesConfig } from './WebpiecesRulesConfig';
import { formatConfigErrorsBanner } from './config-error-banner';

/** One root parse and one owner-resolution pass supply all consumers with the same registry and settings. */
export class LoadedConfig {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly resolved: ResolvedConfig,
        readonly rulesConfig: WebpiecesRulesConfig,
        readonly commands: CommandsConfig,
        readonly prGate: PrGateConfig,
        readonly excludePaths: ExcludePaths,
        readonly matchRules: readonly MatchRuleConfig[],
        readonly configPath: string | null,
        readonly ruleRegistry: RulePackRegistry,
        readonly policyFiles: PackPolicyFilesResult | null,
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class ConfigLoader {
    constructor(
        private readonly configFile: ConfigFile,
        private readonly files: PackPolicyFiles,
        private readonly artifacts: RulePackArtifacts,
    ) {}

    loadAndValidate(cwd: string): LoadedConfig {
        const configPath = this.configFile.findConfigFile(cwd);
        if (!configPath) return this.empty();
        const raw = this.configFile.readRawConfig(configPath),
            root = path.dirname(configPath);
        // webpieces-disable no-any-unknown -- the root parser returns opaque client JSON; these validators narrow every accepted field
        const document = raw as Record<string, unknown>;
        const errors = [
            ...validateTopLevelKeys(document),
            ...validateCommandsSection(raw.commands, document['pr-gate'], root),
            ...validateExcludePaths(raw.excludePaths),
            ...validateMatchRulesSection(raw['match-rules']),
        ];
        if (errors.length) throw new InformAiError(formatConfigErrorsBanner(errors));
        const declarations = this.files.declarations(raw.rulePacks, root);
        const policy = this.files.resolve(root, this.files.select(root, declarations));
        this.artifacts.check(root, policy);
        return this.loaded(
            configPath,
            raw.commands,
            raw.excludePaths as string[],
            raw['match-rules'] as MatchRuleConfig[],
            policy,
        );
    }

    private loaded(
        configPath: string,
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        commandsRaw: unknown,
        excluded: readonly string[],
        matches: readonly MatchRuleConfig[],
        policy: PackPolicyFilesResult,
    ): LoadedConfig {
        const commands = buildCommandsConfig(commandsRaw),
            values = new WebpiecesRulesConfig();
        const resolved = new Map<string, ResolvedRuleConfig>();
        for (const id of policy.registry.ruleIds()) {
            const explicit = policy.values[id];
            values[id] = explicit;
            const options = Object.assign(
                new ConfigObject(),
                policy.registry.optionalTuningFor(id),
                explicit,
            );
            resolved.set(id, new ResolvedRuleConfig(options));
        }
        return new LoadedConfig(
            new ResolvedConfig(resolved, new Set(policy.registry.ruleIds()), configPath),
            values,
            commands,
            commands.prGate,
            new ExcludePaths([...excluded]),
            matches,
            configPath,
            policy.registry,
            policy,
        );
    }

    private empty(): LoadedConfig {
        const commands = buildCommandsConfig(undefined);
        return new LoadedConfig(
            new ResolvedConfig(new Map(), new Set(), null),
            new WebpiecesRulesConfig(),
            commands,
            commands.prGate,
            new ExcludePaths([]),
            [],
            null,
            new RulePackRegistry([]),
            null,
        );
    }
}

const configLoaderSvc = new ConfigLoader(
    new ConfigFile(),
    new PackPolicyFiles(),
    new RulePackArtifacts(new AtomicFile()),
);

/** Public function entry point and injected service use the same implementation. */
// webpieces-disable no-function-outside-class -- canonical public loader function for CLI and executor entry points
export function loadAndValidate(cwd: string): LoadedConfig {
    return configLoaderSvc.loadAndValidate(cwd);
}
