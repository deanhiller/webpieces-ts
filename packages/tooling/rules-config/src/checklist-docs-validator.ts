import * as fs from 'fs';
import * as path from 'path';
import { findConfigFile } from './config-file';
import { validateChecklistsSection } from './validate-config';
import { toError } from './to-error';

/**
 * Validate ONLY the pr-gate `checklists` array, in isolation — that it IS an array (the removed `{ doc }`
 * manifest shape is rejected with its migration steps), each entry's subagent is present, distinct, and
 * names a real `.claude/agents/<subagent>.md`, each entry's repo-relative doc exists, and patterns are
 * string[]. Same logic loadAndValidate runs, but callable directly so broken checklists fail as their OWN
 * `validate-checklist-docs` check (clear owner) instead of surfacing as an unrelated validator's banner.
 * Returns errors; never throws.
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
    // The pr-gate section lives under commands["pr-gate"] (current) or a legacy top-level pr-gate.
    // webpieces-disable no-any-unknown -- narrowing the opaque command section
    const commands = raw['commands'] as Record<string, unknown> | undefined;
    // webpieces-disable no-any-unknown -- narrowing the opaque pr-gate section
    const prGate = (commands?.['pr-gate'] ?? raw['pr-gate']) as Record<string, unknown> | undefined;
    if (!prGate || !('checklists' in prGate)) return [];
    return validateChecklistsSection(prGate['checklists'], repoRoot);
}
