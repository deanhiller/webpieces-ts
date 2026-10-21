import * as path from 'node:path';
import { injectable, bindingScopeValues } from 'inversify';
import { ConfigObject } from '@webpieces/rules-sdk';
import { RepositoryLayout } from '@webpieces/tooling-common';
import { buildCommandsConfig, CommandsConfig } from './commands-config';
import { ConfigFile } from './config-file';
import { RulePackRegistry } from './rule-pack-registry';
import { PackPolicyFiles, PackPolicyFilesResult } from './pack-policy-files';
import { ExcludePaths } from './exclude-hook-paths';
import { PrGateConfig } from './pr-gate-config';
import { ResolvedConfig, ResolvedRuleConfig } from './types';
import { validateCommandsSection } from './commands-section-validators';
import { validateTopLevelKeys } from './config-key-rules';
import { validateExcludePaths, validateMatchRulesSection } from './validate-config';
import { MatchRuleConfig } from './match-rules-config';
import { WebpiecesRulesConfig } from './WebpiecesRulesConfig';
import { PolicyTracking } from './policy-tracking';
import { formatConfigErrorsBanner } from './config-error-banner';
import { ConfigRepairError, EditFileCure, RepositoryLayoutRepair, RunCommandCure } from './config-repair-error';
import { writeTemplate } from './load-template';
import { CONFIG_POLICY_DOC } from './config-error-banner';
import { PRUNE_UNKNOWN_COMMAND } from './constants';

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
    ) {}

    loadAndValidate(cwd: string): LoadedConfig {
        const configPath = this.configFile.findConfigFile(cwd);
        if (!configPath) return this.empty();
        const raw = this.configFile.readRawConfig(configPath),
            root = path.dirname(configPath);
        // webpieces-disable no-any-unknown -- the root parser returns opaque client JSON; these validators narrow every accepted field
        const document = raw as Record<string, unknown>;
        writeTemplate(root, CONFIG_POLICY_DOC);
        const errors = [
            ...validateTopLevelKeys(document),
            ...validateCommandsSection(raw.commands, document['pr-gate'], root),
            ...validateExcludePaths(raw.excludePaths),
            ...validateMatchRulesSection(raw['match-rules']),
        ];
        if (errors.length)
            throw new ConfigRepairError(formatConfigErrorsBanner(errors), [
                new EditFileCure(configPath, `Edit ${configPath} and apply every bullet above.`),
                new RunCommandCure(
                    PRUNE_UNKNOWN_COMMAND,
                    `${PRUNE_UNKNOWN_COMMAND} — deletes every key no validator has a schema for.`,
                ),
            ]);
        new RepositoryLayoutRepair().run(() => new RepositoryLayout().assertCurrent(root));
        const declarations = this.files.declarations(raw.rulePacks, root);
        const policy = this.files.resolve(root, this.files.select(root, declarations));
        return this.loaded(
            configPath,
            raw.commands,
            raw.excludePaths as string[],
            raw['match-rules'] as MatchRuleConfig[],
            policy,
        );
    }

    /**
     * "Policy is shared through the git index": every declared owner file is tracked and not ignored.
     *
     * NOT part of loadAndValidate (#1355). It is a COMMIT-TIME invariant — nothing about it changes
     * between two tool calls — and it costs two `git` processes, so running it on every config load put
     * it on the hottest path there is: every guard-hook invocation. It runs where work is SHARED instead:
     * `wp-ci`, which is the PR gate's build command and CI's. Its refusal (UntrackedPolicyError and the
     * gitignored-policy ConfigRepairError) and their cures are unchanged.
     */
    assertPolicyTracked(cwd: string): void {
        const configPath = this.configFile.findConfigFile(cwd);
        if (!configPath) return;
        const raw = this.configFile.readRawConfig(configPath),
            root = path.dirname(configPath);
        new PolicyTracking().check(root, this.files.declarations(raw.rulePacks, root));
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

const configLoaderSvc = new ConfigLoader(new ConfigFile(), new PackPolicyFiles());

/** Public function entry point and injected service use the same implementation. */
// webpieces-disable no-function-outside-class -- canonical public loader function for CLI and executor entry points
export function loadAndValidate(cwd: string): LoadedConfig {
    return configLoaderSvc.loadAndValidate(cwd);
}

/** The gate-time policy-tracking check — see ConfigLoader.assertPolicyTracked. */
// webpieces-disable no-function-outside-class -- the public function twin of loadAndValidate, for the wp-ci bin
export function assertPolicyTracked(cwd: string): void {
    configLoaderSvc.assertPolicyTracked(cwd);
}
