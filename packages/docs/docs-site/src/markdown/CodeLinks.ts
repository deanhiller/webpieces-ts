import { ApiSpec } from '../spec/ApiSpec';
import { SiteUrls } from '../render/SiteUrls';

/**
 * Which code spans in the document's prose are REFERENCES, and the page each one names (#1284).
 *
 * `@webpieces/openapi-generator` publishes every JSDoc `{@link X}` as a markdown code span holding X's
 * PUBLISHED identity — `` `fetchOrders` `` for an operation (its operationId), `` `Menu` `` for a
 * schema, `` `Menu.items` `` for one of its members. OpenAPI descriptions are CommonMark, so any
 * renderer shows that as code; this site goes one step further and makes it a hyperlink:
 *
 * | code span | links to |
 * |---|---|
 * | exactly an operation's `operationId` | that operation's page |
 * | exactly a schema that has its own page | that schema's page |
 * | `<schema>.<member>` of such a schema | that schema's page |
 * | anything else | nothing — it stays plain code |
 *
 * A name that is BOTH an operationId and a schema links to neither: a guess would be a link that is
 * wrong half the time, and plain code is never wrong. A code span an author wrote by hand that happens
 * to spell a known name links too, which is the point — it names the same thing.
 */
export class CodeLinks {
    constructor(
        /** Operation id -> its page's URL, relative to the site root. */
        private readonly operations: ReadonlyMap<string, string>,
        /** Schema name -> its page's URL, relative to the site root. */
        private readonly schemas: ReadonlyMap<string, string>,
    ) {}

    /** Every operation and every schema with its own page in `spec`, at the URLs `urls` builds. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static of(spec: ApiSpec, urls: SiteUrls): CodeLinks {
        const operations = new Map<string, string>();
        for (const operation of spec.operations()) {
            if (operation.operationId !== '') {
                operations.set(operation.operationId, urls.operation(operation));
            }
        }
        const schemas = new Map<string, string>();
        for (const schema of spec.schemas) {
            if (schema.hasOwnPage) {
                schemas.set(schema.name, urls.schema(schema));
            }
        }
        return new CodeLinks(operations, schemas);
    }

    /** The site-relative URL `code` names, or undefined when it names no page (or two). */
    hrefFor(code: string): string | undefined {
        const operation = this.operations.get(code);
        const schema = this.schemas.get(code);
        if (operation !== undefined || schema !== undefined) {
            return operation !== undefined && schema !== undefined ? undefined : (operation ?? schema);
        }
        // A member tail (`Menu.items`) names its schema's page; an operation has no members.
        const dot = code.indexOf('.');
        return dot > 0 ? this.schemas.get(code.slice(0, dot)) : undefined;
    }
}
