import { DocumentedType } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { UpstreamComponentsIndex } from './UpstreamComponents';

/**
 * Every cure for a type reached in a package that publishes no components document.
 *
 * Tagging is offered ONLY for a package that is already a role:api-lib DTO library (#1064, D5): a
 * general library such as `company-core` is refused the tag by validate-nx-wiring and by the
 * openapi-components-generate executor, so "tag the package" is never a way out of moving the type.
 */
const PUBLISH_COMPONENTS_CURE =
    'Move each type into a role:api-lib DTO library that publishes a components document — as a ' +
    '`…Dto` string enum when it is a string-literal union. Only when the declaring package is ITSELF a ' +
    'role:api-lib DTO library, tag it "generate:openapi-components" so it publishes one (with a ' +
    '"kind": "components" openapi.manifest.json naming its entry files; outside nx, render that manifest ' +
    'with wp-openapi into the directory the package is packed from); a general library is refused the ' +
    "tag. A document references another package's schema; it never copies one in.";

/**
 * The fail-closed refusal of #1058 for the references a document makes into other packages'
 * components documents — see {@link refuse}.
 */
export class UnpublishedComponentsGuard {
    /**
     * FAIL CLOSED (#1058): every type this document references in another package must be a schema
     * of that package's published components document. A package that publishes none is refused —
     * naming the type, its package and the fix — rather than copied in, because silent copying is
     * exactly the duplication this replaces. A document that exists but lacks the schema is stale.
     */
    refuse(
        externalKeys: ReadonlySet<string>,
        types: ReadonlyMap<string, DocumentedType>,
        upstream: UpstreamComponentsIndex,
        fileName: string,
        where: string,
    ): void {
        const unpublished: string[] = [];
        const stale: string[] = [];
        for (const key of Array.from(externalKeys).sort()) {
            const type = types.get(key)!;
            const owner = type.packageName;
            const declared = `${type.name} — declared in ${owner ?? 'no package'} (${type.location})`;
            if (owner === undefined) {
                unpublished.push(
                    `${declared}: its file belongs to no package, so no document can own its schema`,
                );
                continue;
            }
            const published = upstream.publishedBy(owner);
            if (published === undefined) {
                const reason = upstream.missingFor(owner)?.reason ?? 'it was never located';
                unpublished.push(
                    `${declared}: ${owner} publishes no components document — ${reason}`,
                );
            } else if (!published.schemaNames.has(type.schemaName)) {
                stale.push(
                    `${declared}: ${published.documentPath} has no schema '${type.schemaName}'`,
                );
            }
        }
        if (unpublished.length > 0) {
            throw new OpenApiGenerationError(
                `${unpublished.length} type(s) ${fileName} reaches are declared in a package that ` +
                    'publishes no components document',
                where,
                PUBLISH_COMPONENTS_CURE,
                unpublished,
            );
        }
        if (stale.length > 0) {
            throw new OpenApiGenerationError(
                `${stale.length} type(s) ${fileName} references are missing from their package's components document`,
                where,
                'Regenerate the upstream components document before this one — it is older than its ' +
                    'source (in nx, "^openapi-components-generate" in this target\'s dependsOn orders it).',
                stale,
            );
        }
    }
}
