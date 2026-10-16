import { StackedJsDoc } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * The refusal for a declaration with MORE THAN ONE JSDoc block stacked above it (#1286).
 *
 * The extractor records every such declaration it reaches — contract, method, DTO, enum, alias,
 * property — and this guard refuses BEFORE anything is rendered, naming every one of them in a single
 * run, so an author fixing thirty of them is not handed them one build at a time.
 *
 * ## Why a refusal and not "pick the right block"
 *
 * Any choice of block hides the mistake. "First wins" published a 69-line file header as an enum's
 * description; "nearest wins" (TypeScript's own `getDocumentationComment`) still silently drops a doc
 * a refactor stranded on top of a NEW declaration — the declaration it belonged to loses it, and
 * nothing anywhere says so. Each shape has exactly one correct fix and only the author can tell which
 * shape it is, so the cure names both. There is deliberately no flag to switch this off, the same as
 * the unmapped-field refusal: a published description that belongs to something else is a contract
 * telling a partner the wrong thing.
 */
export class StackedJsDocGuard {
    /** Refuse when any of `stacked` exists; `manifestPath` is where the generation was asked from. */
    refuse(stacked: readonly StackedJsDoc[], manifestPath: string): void {
        const unique = new Map<string, StackedJsDoc>();
        for (const each of stacked) {
            if (!unique.has(each.location)) {
                unique.set(each.location, each);
            }
        }
        if (unique.size === 0) {
            return;
        }
        const pointers = Array.from(unique.values()).map(
            (each: StackedJsDoc) =>
                `${each.location} ${each.declaration} — ${each.blockLines.length} JSDoc blocks, ` +
                `starting on lines ${each.blockLines.join(', ')}`,
        );
        throw new OpenApiGenerationError(
            `${unique.size} declaration(s) have more than one JSDoc block stacked above them, so ` +
                'no description can be published for them',
            manifestPath,
            'A section or file header must be a /* */ comment, never /** */; a doc stranded above ' +
                'another declaration must move back onto its own declaration. Leave exactly one ' +
                '/** */ block on each declaration.',
            pointers,
        );
    }
}
