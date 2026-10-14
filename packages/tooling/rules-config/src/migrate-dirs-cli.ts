#!/usr/bin/env node
import { RepositoryLayout, AtomicFile, InformAiError } from '@webpieces/tooling-common';
import { ConfigFile } from './config-file';
import { PackPolicyFiles } from './pack-policy-files';
import { RulePackArtifacts } from './rule-pack-artifacts';
import { RulePackSync, RulePackSyncOptions } from './rule-pack-sync';
import { PolicyTracking } from './policy-tracking';
import { RepoRootFinder } from './repo-root';
import { runMain } from './run-main';

export class MigrateDirsCli {
    async main(): Promise<void> {
        const args = process.argv.slice(2);
        if (args.some((argument) => argument !== '--stage'))
            throw new InformAiError(
                'Usage: pnpm wp-migrate-dirs [--stage]. --stage explicitly stages the migrated policy for commit.',
            );
        const root = new RepoRootFinder().resolveRepoRoot(process.cwd());
        const changed = new RepositoryLayout().migrate(root);
        const atomic = new AtomicFile();
        new RulePackSync(
            new ConfigFile(),
            new PackPolicyFiles(),
            new RulePackArtifacts(atomic),
            atomic,
        ).run(root, new RulePackSyncOptions('sync', null));
        if (args.includes('--stage')) {
            const raw = new ConfigFile().readRawConfig(`${root}/webpieces.config.json`);
            new PolicyTracking().stage(
                root,
                new PackPolicyFiles().declarations(raw.rulePacks, root),
            );
        }
        console.log(
            `Webpieces directories migrated. Review and commit .webpieces-config/ and webpieces.config.json; ignore only .webpieces/.\n${changed.join('\n')}`,
        );
    }
}

if (require.main === module) runMain(() => new MigrateDirsCli().main());
