/**
 * Validate Checklist Docs Executor
 *
 * Validates ONLY the pr-gate `checklists[]` block of webpieces.config.json, in isolation:
 *   - every `docs:` path exists (a checklist pointing at a deleted/typo'd doc silently never fires)
 *   - every `contentPatterns` regex compiles
 *   - `id`s are unique and non-empty
 *   - `blockMessage` is present on every BLOCK checklist
 *
 * This is the SAME logic loadAndValidate runs, but as its own target so a bad checklist config fails as
 * `architecture:validate-checklist-docs` — with a clear owner — instead of surfacing as an unrelated
 * validator's banner because the existence check rode along inside loadAndValidate. Consumers can also
 * point a required CI check at this target.
 *
 * Usage: nx run architecture:validate-checklist-docs
 */

import type { ExecutorContext } from '@nx/devkit';
import { validateChecklistDocs } from '@webpieces/rules-config';

export interface ValidateChecklistDocsOptions {
    // No options — the pr-gate checklist block is the single source of truth.
    placeholder?: never;
}

export interface ExecutorResult {
    success: boolean;
}

// webpieces-disable no-function-outside-class -- nx executor entrypoint; nx invokes the default-exported function
export default function runExecutor(
    _nxOptions: ValidateChecklistDocsOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    console.log('\n📋 Validating pr-gate checklist config (docs exist, patterns compile, ids unique)\n');

    const errors = validateChecklistDocs(context.root);
    if (errors.length === 0) {
        console.log('✅ pr-gate checklists are valid\n');
        return Promise.resolve({ success: true });
    }

    console.error(`❌ ${errors.length} pr-gate checklist config error(s):\n`);
    for (const err of errors) {
        console.error(`  • ${err}`);
    }
    console.error('\nFix the checklists[] block in webpieces.config.json (a missing docs path silently disables a checklist).\n');
    return Promise.resolve({ success: false });
}
