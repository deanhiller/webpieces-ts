import { DocumentedField, DocumentedType } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * The refusals for the field-level `@hidden` JSDoc tag (#1246).
 *
 * `@hidden` withholds ONE field of a DTO from the customer document (`public-openapi.json` and its
 * bundled sibling), the way `@Endpoint(..., { hidden: true })` withholds a whole method. The customer
 * document then describes a SUBSET of the wire shape, and that is honest only when the subset is
 * itself a shape the server accepts and returns. Two declarations break that, and both are refused
 * before anything is rendered, every offender named in one run, with no switch to turn them off:
 *
 * 1. **A hidden field that is REQUIRED.** The customer schema would omit a property the server
 *    insists on: every request a partner builds from the document is rejected, and every response we
 *    send carries a property the document says does not exist. Make it optional (`name?:`).
 * 2. **A type whose EVERY field is hidden.** Its customer schema is an empty object that is still
 *    referenced — a published noun with nothing in it. Hide the method, or the field that holds the
 *    type, instead.
 *
 * A hidden field on a type only a hidden METHOD reaches needs nothing here: the method, and with it
 * every schema only it reaches, is already absent from the customer document.
 *
 * A third refusal is per DOCUMENT rather than per type, and is {@link refuseExternal}: a split
 * customer document `$ref`s another package's type into that package's components document, which
 * every audience shares, so it cannot withhold a field there.
 */
export class HiddenFieldGuard {
    /** Refuse every required hidden field and every all-hidden type among `types`. */
    refuse(types: ReadonlyMap<string, DocumentedType>, where: string): void {
        const required = new Map<string, string>();
        const allHidden = new Map<string, string>();
        for (const type of Array.from(types.values())) {
            this.collect(type, required, allHidden);
        }
        if (required.size === 0 && allHidden.size === 0) {
            return;
        }
        // ONE refusal naming both kinds, so an author is handed every offender in a single run.
        throw new OpenApiGenerationError(
            `${required.size} @hidden field(s) are required, and ${allHidden.size} type(s) have every ` +
                'field @hidden, so the customer document would describe a shape the server does not ' +
                'accept or return',
            where,
            'Make each REQUIRED hidden field optional (`name?: T`) — a hidden field must be one a ' +
                'partner may leave out and may not receive — or remove its @hidden tag. For a type ' +
                'with EVERY field hidden, hide the method that reaches it (`@Endpoint(..., { hidden: ' +
                'true })`) or mark the FIELD that holds it @hidden instead.',
            [
                ...Array.from(required.values()).map((each: string) => `required: ${each}`),
                ...Array.from(allHidden.values()).map(
                    (each: string) => `every field hidden: ${each}`,
                ),
            ],
        );
    }

    /**
     * Refuse when a split customer document references, in another package's components document, a
     * type that has a hidden field (#1246).
     *
     * A components document is ONE document for every audience — the private document and the
     * customer document `$ref` the same schema — so it carries every field. Withholding the field
     * from the customer document would mean defining that package's schema a second time, which the
     * one-owner rule (#1058) forbids; publishing it would leak the field. Neither is acceptable, so
     * the declaration is refused.
     */
    refuseExternal(
        externalKeys: ReadonlySet<string>,
        types: ReadonlyMap<string, DocumentedType>,
        fileName: string,
        where: string,
    ): void {
        const offenders: string[] = [];
        for (const key of Array.from(externalKeys).sort()) {
            const type = types.get(key);
            if (type === undefined) {
                continue;
            }
            for (const field of type.fields) {
                if (field.hidden) {
                    offenders.push(
                        `${type.name}.${field.name} — declared in ${type.packageName ?? 'no package'} (${field.location})`,
                    );
                }
            }
        }
        if (offenders.length === 0) {
            return;
        }
        throw new OpenApiGenerationError(
            `${offenders.length} @hidden field(s) are on types ${fileName} references in another ` +
                "package's components document, which every audience shares, so the field cannot be " +
                'withheld from the customer document',
            where,
            "Declare the type in the contract's own package, so the customer document defines its " +
                'schema and can omit the field — or remove the @hidden tag if the field may be published.',
            offenders,
        );
    }

    private collect(
        type: DocumentedType,
        required: Map<string, string>,
        allHidden: Map<string, string>,
    ): void {
        let hiddenCount = 0;
        for (const field of type.fields) {
            if (!field.hidden) {
                continue;
            }
            hiddenCount += 1;
            if (!field.optional) {
                this.record(required, field, `${type.name}.${field.name} (${field.location})`);
            }
        }
        if (hiddenCount > 0 && hiddenCount === type.fields.length) {
            allHidden.set(type.location, `${type.name} (${type.location})`);
        }
    }

    private record(into: Map<string, string>, field: DocumentedField, text: string): void {
        if (!into.has(field.location)) {
            into.set(field.location, text);
        }
    }
}
