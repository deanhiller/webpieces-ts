import {
    DocLink,
    DocLinkKind,
    DocLinkNaming,
    DocLinkProblem,
    DocLinkText,
    DocumentedType,
} from '@webpieces/api-doc-model';
import { JsonObject, JsonValue } from '../json/JsonObject';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { SchemaPlacement } from './SchemaPlacement';
import { SchemaRenderer } from './SchemaRenderer';

/**
 * How ONE rendered OpenAPI document names a `{@link}` target (#1284): a type by the name its schema
 * carries in THIS document — the stripped schema name, or a bundled document's qualified one — and a
 * contract method by its operationId. A target the document does not publish has no name here.
 */
export class DocumentLinkNaming implements DocLinkNaming {
    constructor(
        private readonly types: ReadonlyMap<string, DocumentedType>,
        private readonly schemas: SchemaRenderer,
        private readonly placement: SchemaPlacement,
        /** `Contract.method` -> operationId, for every operation the document publishes. */
        private readonly operationIds: ReadonlyMap<string, string>,
    ) {}

    publishedName(link: DocLink): string | undefined {
        if (link.kind === DocLinkKind.OPERATION) {
            return this.operationIds.get(`${link.owner}.${link.ownerName}`);
        }
        const type = this.types.get(link.owner);
        if (link.kind !== DocLinkKind.TYPE || type === undefined) {
            return undefined;
        }
        // A single-use request/response wrapper is defined INLINE at its operation (#1303), with its
        // published name as the schema's `title` — so the link names that title. No schema page
        // exists for it, which a docs site sees because `components.schemas` has no entry.
        if (this.schemas.inlinedTypes().has(link.owner)) {
            return type.schemaName;
        }
        if (this.schemas.reachedTypes().has(link.owner)) {
            return this.placement.localName(link.owner, type);
        }
        // A schema `$ref`d into another package's components document is published THERE, under
        // its own schema name, so the reference is still a real one.
        return this.schemas.externalTypes().has(link.owner) ? type.schemaName : undefined;
    }
}

/**
 * Resolves every `{@link}` in a rendered document, and REFUSES the ones it cannot name (#1284).
 *
 * A link is resolved AFTER the document is built, over every string in it, rather than at each place
 * a description is written: prose reaches a document through a dozen slots — operation and schema
 * descriptions, `@returns`, `@summary`, tag descriptions, `x-mcp-*` — and one walk cannot miss a slot
 * the next change adds.
 *
 * ## Why an unnameable link is a refusal
 *
 * A link the compiler cannot resolve, or one to a type or operation this document does not publish,
 * is the same silent leak #1284 was filed about: the prose names something a partner cannot find. So
 * generation fails, naming every offender with its `file:line` in ONE run across every document — the
 * same shape as the stacked-JSDoc and missing-`@returns` guards. A URL link is never one: it was
 * written out as a markdown link at extraction.
 */
export class DocLinkGuard {
    /** By `location written`, so one link refused in several documents is named once. */
    private readonly problems = new Map<string, DocLinkProblem>();

    /** Resolve every string in `document` in place. */
    resolve(document: JsonObject, naming: DocLinkNaming, fileName: string): void {
        const found: DocLinkProblem[] = [];
        this.walkObject(document, naming, `${fileName}.json`, found);
        for (const problem of found) {
            const key = `${problem.location} ${problem.written}`;
            if (!this.problems.has(key)) {
                this.problems.set(key, problem);
            }
        }
    }

    /** Refuse when any link of any document resolved so far could not be named. */
    refuse(manifestPath: string): void {
        if (this.problems.size === 0) {
            return;
        }
        throw new OpenApiGenerationError(
            `${this.problems.size} {@link} reference(s) name nothing the generated document publishes`,
            manifestPath,
            'Point each {@link} at a type the document publishes or an @Endpoint method of a ' +
                'contract it publishes, imported into the file the JSDoc is in — or write the name as ' +
                "plain text. A link is published as the target's published name, so it must have one.",
            Array.from(this.problems.values()).map((each: DocLinkProblem) => each.toString()),
        );
    }

    private walkObject(
        object: JsonObject,
        naming: DocLinkNaming,
        output: string,
        found: DocLinkProblem[],
    ): void {
        for (const key of object.keys()) {
            object.set(key, this.walk(object.get(key)!, naming, output, found));
        }
    }

    private walk(
        value: JsonValue,
        naming: DocLinkNaming,
        output: string,
        found: DocLinkProblem[],
    ): JsonValue {
        if (typeof value === 'string') {
            return DocLinkText.hasLinks(value)
                ? DocLinkText.resolve(value, naming, output, found)
                : value;
        }
        if (value instanceof JsonObject) {
            this.walkObject(value, naming, output, found);
            return value;
        }
        if (Array.isArray(value)) {
            return value.map((each: JsonValue) => this.walk(each, naming, output, found));
        }
        return value;
    }
}
