import * as fs from 'fs';
import * as path from 'path';
import { findConfigFile } from './config-file';
import { validateChecklists } from './validate-config';
import { toError } from './to-error';

/**
 * Validate ONLY the pr-gate `checklists[]` block, in isolation — docs paths exist, contentPatterns
 * compile, ids are unique, blockMessage present on BLOCK entries. This is the same logic
 * loadAndValidate runs (validateChecklists), but callable directly so a missing/typo'd `docs:` path
 * fails as its OWN `validate-checklist-docs` check (with a clear owner) instead of surfacing as an
 * unrelated validator's banner because it rode along inside loadAndValidate. Returns human-readable
 * errors; never throws.
 */
// webpieces-disable no-function-outside-class -- module-level config validator, matches validate-config.ts
export function validateChecklistDocs(cwd: string): string[] {
    const configPath = findConfigFile(cwd);
    if (!configPath) return [];
    // webpieces-disable no-any-unknown -- parsed config JSON is opaque until narrowed below
    let raw: Record<string, unknown>;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: a malformed config surfaces as one readable error
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // webpieces-disable no-any-unknown -- parsed config JSON is opaque until narrowed below
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (err: unknown) {
        const error = toError(err);
        return [`[pr-gate] ${path.basename(configPath)} is not valid JSON: ${error.message}`];
    }
    const repoRoot = path.dirname(configPath);
    // Checklists live under commands["pr-gate"].checklists (current) or the legacy top-level pr-gate.
    // webpieces-disable no-any-unknown -- narrowing the opaque command section
    const commands = raw['commands'] as Record<string, unknown> | undefined;
    // webpieces-disable no-any-unknown -- narrowing the opaque pr-gate section
    const prGate = (commands?.['pr-gate'] ?? raw['pr-gate']) as Record<string, unknown> | undefined;
    if (!prGate || !('checklists' in prGate)) return [];
    return validateChecklists(prGate['checklists'], repoRoot);
}
