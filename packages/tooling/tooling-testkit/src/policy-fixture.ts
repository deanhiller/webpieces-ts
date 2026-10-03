import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    RulePackManifest,
    FieldDef,
    ConfigObject,
    OwnedRuleDefinition,
    RetiredConfigKey,
} from '@webpieces/rules-sdk';
import { specTempDirs } from './spec-temp-dirs';
import snapshot from './legacy-owned-policies.json';

class OwnershipBaseline {
    schemas!: Record<string, Record<string, FieldDef>>;
    tuning!: Record<string, ConfigObject>;
    seeds!: Record<string, ConfigObject>;
    migrations!: readonly RetiredConfigKey[];
    owners!: Record<string, string[]>;
}
const baseline = snapshot as OwnershipBaseline;

/** A test host supplies the real artifact renderer without creating a production dependency edge. */
export interface FixtureArtifactWriter {
    write(root: string): void;
}

/** Frozen pre-migration policy data for real config-loader fixtures; never used by product code. */
export class PolicyFixture {
    private artifactWriter: FixtureArtifactWriter | null = null;

    registerArtifactWriter(writer: FixtureArtifactWriter): void {
        this.artifactWriter = writer;
    }

    /** Explicit fixture migration preserves missing entries/fields so fail-closed assertions remain real. */
    // webpieces-disable no-any-unknown -- test-only JSON conversion; runtime loading never accepts this old input shape
    writeOwnerConfig(
        root: string,
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        document: Record<string, unknown>,
        manifests: readonly RulePackManifest[] = this.manifests(),
    ): void {
        if (!this.artifactWriter)
            throw new Error(
                'Register a real FixtureArtifactWriter before writing a migrated policy fixture.',
            );
        this.declareIn(root, manifests);
        const flat = Object.assign({}, document['rules'], document['hookGuards']) as Record<
            string,
            ConfigObject
        >;
        const owned = new Set(
            manifests.flatMap((manifest: RulePackManifest) =>
                manifest.ownedRules.map((definition: OwnedRuleDefinition) => definition.id),
            ),
        );
        const declarations = manifests.map((manifest: RulePackManifest, index: number) => {
            const filename = `.webpieces/rules/fixture-${index}.json`;
            const entries = Object.fromEntries(
                manifest.ownedRules
                    .filter((definition: OwnedRuleDefinition) => Object.hasOwn(flat, definition.id))
                    .map((definition: OwnedRuleDefinition) => [definition.id, flat[definition.id]]),
            );
            // Unknown keys stay invalid instead of being dropped during fixture migration.
            if (index === 0)
                for (const id of Object.keys(flat)) if (!owned.has(id)) entries[id] = flat[id];
            fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
            fs.writeFileSync(path.join(root, filename), JSON.stringify(entries, null, 2) + '\n');
            return { package: `./fixture-policy-${index}.cjs`, config: filename };
        });
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        const next = { ...document, rulePacks: declarations } as Record<string, unknown>;
        delete next['rules'];
        delete next['hookGuards'];
        if (Array.isArray(next['rulesDir']) && next['rulesDir'].length === 0)
            delete next['rulesDir'];
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify(next, null, 2) + '\n',
        );
        this.artifactWriter.write(root);
    }

    manifests(): readonly RulePackManifest[] {
        return Object.keys(baseline.owners)
            .filter((owner: string) => owner !== '@webpieces/eslint-rules')
            .map((owner: string) => {
                const ids = baseline.owners[owner];
                return {
                    packageName: owner,
                    packageVersion: '1.0.0-fixture',
                    apiVersion: 3,
                    ownedRules: ids.map((id: string) => ({
                        id,
                        schema: baseline.schemas[id as keyof typeof baseline.schemas],
                        schemaApiVersion: 1,
                        optionalTuning: baseline.tuning[id as keyof typeof baseline.tuning] ?? {},
                        recommendedSeed: baseline.seeds[id as keyof typeof baseline.seeds],
                        help: {
                            description: `Frozen fixture policy ${id}`,
                            remediation: 'Configure explicitly in {configFile}.',
                        },
                        section:
                            owner === '@webpieces/agent-workflow-rules' ? 'hookGuards' : 'rules',
                    })),
                    contributions: this.contributions(owner, ids),
                    migrations: baseline.migrations.filter(
                        (entry: RetiredConfigKey) =>
                            (owner === '@webpieces/agent-workflow-rules' &&
                                (entry.scope === 'rule' ||
                                    entry.key.startsWith('pr-lifecycle-guard.'))) ||
                            (owner === '@webpieces/nx-webpieces-rules' &&
                                entry.scope === 'field' &&
                                entry.key.startsWith('runtime-architecture.')),
                    ),
                    safeguards: [],
                } as RulePackManifest;
            });
    }

    private contributions(
        owner: string,
        ids: readonly string[],
    ): RulePackManifest['contributions'] {
        const module = `${owner}/rule-runtime`;
        if (owner === '@webpieces/agent-workflow-rules')
            return ids.map((id: string) => ({
                ruleId: id,
                ownerPack: owner,
                executionKind: 'workflow-guard',
                implementationModule: module,
            }));
        if (owner === '@webpieces/code-rules')
            return ids.map((id: string) => ({
                ruleId: id,
                ownerPack: owner,
                executionKind: 'build',
                implementationModule: module,
            }));
        if (owner === '@webpieces/nx-webpieces-rules')
            return [
                ...ids.map((id: string) => ({
                    ruleId: id,
                    ownerPack: owner,
                    executionKind: 'build' as const,
                    implementationModule: module,
                })),
                {
                    ruleId: 'validate-ts-in-src',
                    ownerPack: '@webpieces/ai-hook-rules',
                    executionKind: 'build',
                    implementationModule: module,
                },
            ];
        const shared = [
            'no-any-unknown',
            'no-implicit-any',
            'max-file-lines',
            'no-destructure',
            'require-return-type',
            'no-unmanaged-exceptions',
            'catch-error-pattern',
            'no-symbol-di-tokens',
            'no-custom-css',
            'no-process-exit-outside-main',
        ];
        return [
            ...ids.map((id: string) => ({
                ruleId: id,
                ownerPack: owner,
                executionKind: 'source-hook' as const,
                implementationModule: module,
            })),
            ...shared.map((id: string) => ({
                ruleId: id,
                ownerPack: '@webpieces/code-rules',
                executionKind: 'source-hook' as const,
                implementationModule: module,
            })),
        ];
    }

    /** Explicitly declares real CommonJS fixture modules; the real Node module transport loads them. */
    declareIn(root: string, manifests: readonly RulePackManifest[] = this.manifests()): void {
        const packageFile = path.join(root, 'package.json');
        // webpieces-disable no-any-unknown -- fixture package JSON retains unrelated test fields
        const pkg: Record<string, unknown> = fs.existsSync(packageFile)
            ? JSON.parse(fs.readFileSync(packageFile, 'utf8'))
            : { private: true };
        const declarations = manifests.map((manifest: RulePackManifest, index: number) => {
            const module = `./fixture-policy-${index}.cjs`;
            fs.writeFileSync(
                path.join(root, module),
                `exports.rulePackManifest = ${JSON.stringify(manifest)};\n`,
            );
            return { module };
        });
        pkg['webpieces'] = { rulePacks: declarations };
        fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
    }

    /** Use deliberately in policy-loading tests, instead of modifying the generic temp-directory helper. */
    makeRepo(prefix: string): string {
        const root = specTempDirs.make(prefix);
        this.declareIn(root);
        return root;
    }
}

export const policyFixture = new PolicyFixture();
export const fixtureSchemas = baseline.schemas;
export const fixtureTuning = baseline.tuning;
export const fixtureMigrations = baseline.migrations;
export const fixtureHookGuardNames = policyFixture
    .manifests()
    .flatMap((pack: RulePackManifest) =>
        pack.ownedRules
            .filter((rule: OwnedRuleDefinition) => rule.section === 'hookGuards')
            .map((rule: OwnedRuleDefinition) => rule.id),
    );
