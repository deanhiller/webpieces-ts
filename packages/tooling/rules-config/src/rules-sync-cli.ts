#!/usr/bin/env node
import { AtomicFile, InformAiError } from '@webpieces/tooling-common';
import { ConfigFile } from './config-file';
import { PackPolicyDeclaration, PackPolicyFiles } from './pack-policy-files';
import { RulePackArtifacts } from './rule-pack-artifacts';
import { RulePackSync, RulePackSyncOptions } from './rule-pack-sync';
import { RepoRootFinder } from './repo-root';
import { runMain } from './run-main';

/** CLI parsing does not validate the live config: this command repairs missing required settings. */
export class RulesSyncCli {
    parse(args: readonly string[]): RulePackSyncOptions {
        let mode: 'sync' | 'upgrade' = 'sync';
        const declarations: PackPolicyDeclaration[] = [];
        for (let index = 0; index < args.length; index++) {
            const argument = args[index];
            if (argument === '--upgrade') {
                mode = 'upgrade';
                continue;
            }
            const value =
                argument === '--pack'
                    ? args[++index]
                    : argument.startsWith('--pack=')
                      ? argument.slice(7)
                      : undefined;
            if (!value || value.indexOf('=') <= 0 || value.endsWith('=')) {
                throw new InformAiError(
                    'Usage: pnpm wp-rules-sync [--upgrade] [--pack=<package-or-module>=<repository-relative-config.json>] ...',
                );
            }
            const separator = value.indexOf('=');
            declarations.push(
                new PackPolicyDeclaration(value.slice(0, separator), value.slice(separator + 1)),
            );
        }
        return new RulePackSyncOptions(mode, declarations.length ? declarations : null);
    }

    async main(): Promise<void> {
        const atomic = new AtomicFile(),
            root = new RepoRootFinder().resolveRepoRoot(process.cwd());
        const sync = new RulePackSync(
            new ConfigFile(),
            new PackPolicyFiles(),
            new RulePackArtifacts(atomic),
            atomic,
        );
        const changed = sync.run(root, this.parse(process.argv.slice(2)));
        console.log(
            changed.length
                ? `Review and commit these explicit config/artifact changes:\n${changed.join('\n')}`
                : 'Rule config and generated artifacts already agree.',
        );
    }
}

if (require.main === module) runMain(() => new RulesSyncCli().main());
