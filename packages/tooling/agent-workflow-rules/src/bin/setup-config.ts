import * as fs from 'node:fs';
import * as path from 'node:path';
import { AtomicFile, InformAiError } from '@webpieces/tooling-common';
import {
    ConfigFile,
    CONFIG_FILENAME,
    PackPolicyFiles,
    RulePackArtifacts,
    RulePackSync,
    RulePackSyncOptions,
} from '@webpieces/rules-config';

/** Installation syncs declared owner files; flat roots require the explicit upgrade operation. */
// webpieces-disable no-function-outside-class -- DI-free installer composition must work before hooks are wired
export function seedOrSyncConfig(projectRoot: string): void {
    const filename = path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(filename)) {
        throw new InformAiError(
            'Create webpieces.config.json with explicit rulePacks, commands, excludePaths and match-rules, then run pnpm wp-rules-sync to write reviewed owner seeds. Installed packages are never inferred as selected policy packs.',
        );
    }
    const configFile = new ConfigFile(),
        raw = configFile.readRawConfig(filename);
    if (raw.rulePacks === undefined) {
        throw new InformAiError(
            'The flat root config is retired. Run pnpm wp-rules-sync --upgrade with explicit --pack=<package>=<config.json> declarations, review the owner files and artifacts, then rerun hook installation.',
        );
    }
    const atomic = new AtomicFile();
    const changed = new RulePackSync(
        configFile,
        new PackPolicyFiles(),
        new RulePackArtifacts(atomic),
        atomic,
    ).run(projectRoot, new RulePackSyncOptions('sync', null));
    console.log(
        changed.length
            ? `[ai-hooks] Review explicit owner config/artifact changes:\n${changed.join('\n')}`
            : '[ai-hooks] Declared owner config and artifacts already agree.',
    );
}
