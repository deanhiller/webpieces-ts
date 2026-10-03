import * as fs from 'node:fs';
import * as path from 'node:path';
import { RulePackManifest, FieldDef, ConfigObject } from '@webpieces/rules-sdk';
import { specTempDirs } from './spec-temp-dirs';
import snapshot from './legacy-owned-policies.json';

class OwnershipBaseline {
    schemas!: Record<string, Record<string, FieldDef>>;
    tuning!: Record<string, ConfigObject>;
    seeds!: Record<string, ConfigObject>;
    migrations!: typeof snapshot.migrations;
    owners!: Record<string, string[]>;
}
const baseline = snapshot as OwnershipBaseline;

/** Frozen pre-migration policy data for real config-loader fixtures; never used by product code. */
export class PolicyFixture {
    manifests(): readonly RulePackManifest[] {
        return Object.entries(baseline.owners).filter(([owner]) => owner !== '@webpieces/eslint-rules').map(([owner, ids]) => ({
            packageName: owner, packageVersion: '1.0.0-fixture', apiVersion: 2,
            ownedRules: ids.map(id => ({
                id, schema: baseline.schemas[id as keyof typeof baseline.schemas], schemaApiVersion: 1,
                optionalTuning: baseline.tuning[id as keyof typeof baseline.tuning] ?? {},
                recommendedSeed: baseline.seeds[id as keyof typeof baseline.seeds],
                section: owner === '@webpieces/agent-workflow-rules' ? 'hookGuards' : 'rules',
            })),
            contributions: [],
            migrations: baseline.migrations.filter(entry =>
                (owner === '@webpieces/agent-workflow-rules' && (entry.scope === 'rule' || entry.key.startsWith('pr-lifecycle-guard.'))) ||
                (owner === '@webpieces/nx-webpieces-rules' && entry.scope === 'field' && entry.key.startsWith('runtime-architecture.'))),
            safeguards: [],
        } as RulePackManifest));
    }

    /** Explicitly declares real CommonJS fixture modules; the real Node module transport loads them. */
    declareIn(root: string, manifests: readonly RulePackManifest[] = this.manifests()): void {
        const packageFile = path.join(root, 'package.json');
        // webpieces-disable no-any-unknown -- fixture package JSON retains unrelated test fields
        const pkg: Record<string, unknown> = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : { private: true };
        const declarations = manifests.map((manifest, index) => {
            const module = `./fixture-policy-${index}.cjs`;
            fs.writeFileSync(path.join(root, module), `exports.rulePackManifest = ${JSON.stringify(manifest)};\n`);
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
export const fixtureHookGuardNames = policyFixture.manifests().flatMap(pack => pack.ownedRules.filter(rule => rule.section === 'hookGuards').map(rule => rule.id));
