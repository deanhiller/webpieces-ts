import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

export const CONFIG_FILENAME = 'webpieces.config.json';

// Raw shape of webpieces.config.json as parsed from JSON, before validation/typing.
//  - `rules`      — code-style validators (scope edit/file).
//  - `hookGuards` — git/PR/branch protection guards (scope bash).
//  - `commands`   — gated command config the guards point at; `pr-gate` lives inside it. Carried as
//                   opaque JSON because its nested `gates` array can't be expressed in the FieldDef
//                   schema; validated structurally by validateCommandsSection.
//  - `pr-gate`    — DEPRECATED top-level block (pre-migration layout). Read only as a back-compat
//                   fallback / to emit a "move it under commands" migration error.
// webpieces-disable no-any-unknown -- consumer JSON config has opaque rule option values
export interface RawConfigFile {
    extends?: string;
    rules?: Record<string, Record<string, unknown>>;
    hookGuards?: Record<string, Record<string, unknown>>;
    // webpieces-disable no-any-unknown -- opaque commands JSON, validated by validateCommandsSection
    commands?: unknown;
    // REQUIRED top-level block: two glob lists that suppress hook enforcement per file path.
    // Opaque here (validated structurally by validateExcludePaths, then parsed into ExcludePaths).
    // webpieces-disable no-any-unknown -- opaque excludePaths JSON, validated by validateExcludePaths
    excludePaths?: unknown;
    // REQUIRED top-level array of client-authored content guards (regex patterns + message + scoping).
    // Opaque here; validated structurally by validateMatchRulesSection, then parsed into MatchRuleConfig[].
    // webpieces-disable no-any-unknown -- opaque match-rules JSON, validated by validateMatchRulesSection
    'match-rules'?: unknown;
    rulesDir?: string[];
    // webpieces-disable no-any-unknown -- DEPRECATED top-level pr-gate, migrated under `commands`
    'pr-gate'?: unknown;
}

/**
 * Locates + reads webpieces.config.json. `@injectable(bindingScopeValues.Singleton)` so it can be injected into the config
 * loader and appear in the rules-config DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ConfigFile {
    /** Walk up from `startDir` looking for webpieces.config.json. Returns its absolute path or null. */
    findConfigFile(startDir: string): string | null {
        let dir = startDir;
        while (true) {
            const primary = path.join(dir, CONFIG_FILENAME);
            if (fs.existsSync(primary)) return primary;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }

    /** Read + JSON.parse webpieces.config.json, surfacing parse failures as a readable InformAiError. */
    readRawConfig(configPath: string): RawConfigFile {
        const raw = fs.readFileSync(configPath, 'utf8');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return JSON.parse(raw) as RawConfigFile;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `webpieces.config.json has invalid JSON — fix the file, then retry.\n` +
                `Parse error: ${error.message}\n` +
                `File: ${configPath}`,
            );
        }
    }
}

// Temporary migration delegators — consumers migrate to injecting ConfigFile over follow-up PRs, then
// these free functions are removed. Declarations kept identical to the originals (unchanged lines).
const configFileSvc = new ConfigFile();

/**
 * Walk up from `startDir` looking for webpieces.config.json. Returns its absolute path or null.
 */
export function findConfigFile(startDir: string): string | null {
    return configFileSvc.findConfigFile(startDir);
}

/**
 * Read + JSON.parse webpieces.config.json, surfacing parse failures as a readable InformAiError.
 */
export function readRawConfig(configPath: string): RawConfigFile {
    return configFileSvc.readRawConfig(configPath);
}
