import { DocumentedType } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * The refusal for a published schema whose declaration has no JSDoc description (#1292).
 *
 * A class, interface, enum or union alias a document DEFINES in `components.schemas` publishes its
 * declaration's `/** *\/` as the schema's `description`. One with no JSDoc used to publish no
 * description, silently — and a partner reading a schema page with no description is the defect. Only
 * a hard fail makes somebody write it, so this collects every offender across every document of the
 * run and refuses ONCE, naming each type and the file it is declared in; nothing is written. There is
 * deliberately no flag to switch it off, the same as {@link StackedJsDocGuard}.
 *
 * It judges every document the run writes: the split `full-private-openapi` / `public-openapi` (the
 * types each DEFINES — a type another package declares is judged by that package's own components
 * generation), a DTO library's `components.openapi`, and the MCP projection, which inlines every type
 * it reaches from any package — so the `mcp-<Contract>-tools.json` catalogs, whose tools are that
 * projection's tool operations, are covered too. A type declared under `node_modules` is never
 * judged: it is that published package's to own, the same line the stacked-JSDoc guard draws.
 */
export class UndocumentedSchemaGuard {
    private readonly undocumented = new Map<string, string>();

    /** Record every type of `keys` (keys into `types`) whose declaration has no description. */
    collect(keys: Iterable<string>, types: ReadonlyMap<string, DocumentedType>): void {
        for (const key of keys) {
            const type = types.get(key);
            if (type === undefined || type.description.trim() !== '') {
                continue;
            }
            if (type.location.includes('/node_modules/')) {
                continue;
            }
            if (!this.undocumented.has(type.location)) {
                this.undocumented.set(type.location, `${type.name} (${type.location})`);
            }
        }
    }

    /** Refuse when anything was collected; `manifestPath` is where the generation was asked from. */
    refuse(manifestPath: string): void {
        if (this.undocumented.size === 0) {
            return;
        }
        const pointers = Array.from(this.undocumented.values()).sort();
        throw new OpenApiGenerationError(
            `${this.undocumented.size} published schema(s) have no JSDoc description`,
            manifestPath,
            'Write a /** */ block on each declaration named below saying what the type IS — it is ' +
                "published as the schema's description, and a schema page with no description " +
                'tells a partner nothing.',
            pointers,
        );
    }
}
