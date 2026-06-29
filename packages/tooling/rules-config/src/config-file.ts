import * as fs from 'fs';
import * as path from 'path';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

export const CONFIG_FILENAME = 'webpieces.config.json';

// Raw shape of webpieces.config.json as parsed from JSON, before validation/typing. `pr-gate` is a
// top-level sibling of `rules` (its nested `gates` array can't be expressed in the FieldDef schema),
// so it is carried here as opaque JSON and validated structurally by validatePrGateSection.
// webpieces-disable no-any-unknown -- consumer JSON config has opaque rule option values
export interface RawConfigFile {
    extends?: string;
    rules?: Record<string, Record<string, unknown>>;
    rulesDir?: string[];
    // webpieces-disable no-any-unknown -- opaque pr-gate JSON, validated by validatePrGateSection
    'pr-gate'?: unknown;
}

/**
 * Walk up from `startDir` looking for webpieces.config.json. Returns its absolute path or null.
 */
export function findConfigFile(startDir: string): string | null {
    let dir = startDir;
    while (true) {
        const primary = path.join(dir, CONFIG_FILENAME);
        if (fs.existsSync(primary)) return primary;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Read + JSON.parse webpieces.config.json, surfacing parse failures as a readable InformAiError.
 */
export function readRawConfig(configPath: string): RawConfigFile {
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
