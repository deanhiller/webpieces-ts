import * as fs from 'node:fs';
import * as path from 'node:path';
import { AtomicFile, InformAiError } from '@webpieces/tooling-common';
import { ConfigFile, CONFIG_FILENAME, CONFIG_DOCUMENTATION_KEY, CONFIG_DOCUMENTATION_PATH, PackPolicyFiles, RulePackSync } from '@webpieces/rules-config';
import { INSTALL_HOOKS_CMD } from './l0-allowlist';

/** Installation seeds the declared owner files; a flat root config must first declare its rulePacks. */
// webpieces-disable no-function-outside-class -- DI-free installer composition must work before hooks are wired
export function seedOrSyncConfig(projectRoot: string): void {
    const filename = path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(filename)) {
        throw new InformAiError(
            `Create webpieces.config.json with "${CONFIG_DOCUMENTATION_KEY}": "${CONFIG_DOCUMENTATION_PATH}", explicit rulePacks, commands, excludePaths and match-rules, then rerun ${INSTALL_HOOKS_CMD}: it writes the owners' recommended seeds into the declared files for review. Installed packages are never inferred as selected policy packs.`,
        );
    }
    const configFile = new ConfigFile(),
        raw = configFile.readRawConfig(filename);
    if (raw.rulePacks === undefined) {
        throw new InformAiError(
            `The flat root config is retired. Add "rulePacks": [{"package":"<pack>","config":".webpieces-config/rules/<pack>.json"}, ...] to webpieces.config.json, move each "rules"/"hookGuards" entry into the owner file its pack declares, delete those two sections, then rerun ${INSTALL_HOOKS_CMD}.`,
        );
    }
    const changed = new RulePackSync(configFile, new PackPolicyFiles(), new AtomicFile()).run(projectRoot);
    console.log(
        changed.length
            ? `[ai-hooks] Review explicit owner config changes:\n${changed.join('\n')}`
            : '[ai-hooks] Declared owner config files already hold every owned rule.',
    );
}
