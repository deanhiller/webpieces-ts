import { injectable, bindingScopeValues } from 'inversify';
import { JsonObject, JsonValue } from './json-value';

export type ContractChangeKind = 'added' | 'removed' | 'changed';

/** One partner-visible difference between two OpenAPI documents. Data-only. */
export class ContractChange {
    constructor(
        readonly kind: ContractChangeKind,
        /** What moved, as a reviewer names it: `POST /orders/fetch`, `webhook order.state-changed`, `schema Order`. */
        readonly subject: string,
        /** For `changed`: which parts of it moved, e.g. `+ field window`, `requestBody`. Empty otherwise. */
        readonly details: readonly string[],
    ) {}
}

type Entry = [string, JsonValue];

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

/** The document sections walked item by item; everything else is compared as one value per key. */
const WALKED = new Set(['paths', 'webhooks', 'components']);

/**
 * The partner-visible difference between two OpenAPI documents, item by item: operations, webhooks,
 * named schemas, and every other top-level section (info, servers, security, tags).
 *
 * It compares STRUCTURE, never text: a key reordering is not a change, and a changed operation reports
 * WHICH of its parts moved, so the PR comment says "the 200 response changed" rather than dumping two
 * JSON blobs for a reviewer to diff by eye.
 *
 * `before` is `undefined` when the merge-base had no document — a brand-new contract — which makes
 * every item `added`; `after` is `undefined` when HEAD dropped the document.
 */
@injectable(bindingScopeValues.Singleton)
export class OpenApiContractDiff {
    diff(before: JsonObject | undefined, after: JsonObject | undefined): ContractChange[] {
        const base = before ?? {};
        const head = after ?? {};
        return [
            ...this.operations(base, head, 'paths', (key: string, method: string): string => `${method.toUpperCase()} ${key}`),
            ...this.operations(base, head, 'webhooks', (key: string, method: string): string => `webhook ${key} (${method.toUpperCase()})`),
            ...this.schemas(base, head),
            ...this.topLevel(base, head),
        ];
    }

    private operations(
        base: JsonObject, head: JsonObject, section: string, name: (key: string, method: string) => string,
    ): ContractChange[] {
        const before = this.flatten(this.object(base[section]), name);
        const after = this.flatten(this.object(head[section]), name);
        return this.compare(before, after, (was: JsonValue | undefined, now: JsonValue | undefined): string[] =>
            this.changedKeys(this.object(was), this.object(now)));
    }

    /** `paths` → one entry per `<METHOD> <path>`, so an added method on an existing path is its own line. */
    private flatten(section: JsonObject, name: (key: string, method: string) => string): Map<string, JsonValue> {
        const out = new Map<string, JsonValue>();
        for (const key of Object.keys(section).sort()) {
            const item = this.object(section[key]);
            for (const method of METHODS) {
                if (item[method] !== undefined) out.set(name(key, method), item[method]);
            }
        }
        return out;
    }

    private schemas(base: JsonObject, head: JsonObject): ContractChange[] {
        const named = (doc: JsonObject): Map<string, JsonValue> => {
            const schemas = this.object(this.object(doc['components'])['schemas']);
            return new Map(Object.keys(schemas).sort().map((key: string): Entry => [`schema ${key}`, schemas[key]]));
        };
        const componentsRest = this.compare(
            this.componentsOtherThanSchemas(base), this.componentsOtherThanSchemas(head),
            (): string[] => [],
        );
        return [
            ...this.compare(named(base), named(head), (was: JsonValue | undefined, now: JsonValue | undefined): string[] =>
                this.schemaDetails(this.object(was), this.object(now))),
            ...componentsRest,
        ];
    }

    private componentsOtherThanSchemas(doc: JsonObject): Map<string, JsonValue> {
        const components = this.object(doc['components']);
        return new Map(Object.keys(components).filter((key: string) => key !== 'schemas').sort()
            .map((key: string): Entry => [`components.${key}`, components[key]]));
    }

    private topLevel(base: JsonObject, head: JsonObject): ContractChange[] {
        const rest = (doc: JsonObject): Map<string, JsonValue> => new Map(Object.keys(doc)
            .filter((key: string) => !WALKED.has(key)).sort()
            .map((key: string): Entry => [`document ${key}`, doc[key]]));
        return this.compare(rest(base), rest(head), (): string[] => []);
    }

    /** Field-level detail for a changed object schema; anything else about it by key. */
    private schemaDetails(was: JsonObject, now: JsonObject): string[] {
        const wasProps = this.object(was['properties']);
        const nowProps = this.object(now['properties']);
        const details: string[] = [];
        for (const key of this.union(wasProps, nowProps)) {
            if (!(key in nowProps)) details.push(`- field ${key}`);
            else if (!(key in wasProps)) details.push(`+ field ${key}`);
            else if (!this.same(wasProps[key], nowProps[key])) details.push(`~ field ${key}`);
        }
        const wasRequired = this.strings(was['required']);
        const nowRequired = this.strings(now['required']);
        for (const key of nowRequired.filter((each: string) => !wasRequired.includes(each))) details.push(`now required: ${key}`);
        for (const key of wasRequired.filter((each: string) => !nowRequired.includes(each))) details.push(`now optional: ${key}`);
        const rest = (schema: JsonObject): JsonObject => {
            const copy: JsonObject = { ...schema };
            delete copy['properties'];
            delete copy['required'];
            return copy;
        };
        return [...details, ...this.changedKeys(rest(was), rest(now))];
    }

    private compare(
        before: Map<string, JsonValue>, after: Map<string, JsonValue>, detail: (was: JsonValue | undefined, now: JsonValue | undefined) => string[],
    ): ContractChange[] {
        const changes: ContractChange[] = [];
        for (const subject of after.keys()) {
            const now = after.get(subject);
            if (!before.has(subject)) changes.push(new ContractChange('added', subject, []));
            else if (!this.same(before.get(subject), now)) changes.push(new ContractChange('changed', subject, detail(before.get(subject), now)));
        }
        for (const subject of before.keys()) {
            if (!after.has(subject)) changes.push(new ContractChange('removed', subject, []));
        }
        return changes;
    }

    private changedKeys(was: JsonObject, now: JsonObject): string[] {
        return this.union(was, now).filter((key: string) => !this.same(was[key], now[key]));
    }

    private union(a: JsonObject, b: JsonObject): string[] {
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    }

    /** Structural equality: object key ORDER never counts, array order does. */
    private same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
        return this.canonical(a) === this.canonical(b);
    }

    private canonical(value: JsonValue | undefined): string {
        if (Array.isArray(value)) return `[${value.map((each: JsonValue) => this.canonical(each)).join(',')}]`;
        if (value !== null && typeof value === 'object') {
            const obj = value as JsonObject;
            return `{${Object.keys(obj).sort().map((key: string) => `${JSON.stringify(key)}:${this.canonical(obj[key])}`).join(',')}}`;
        }
        return JSON.stringify(value) ?? 'undefined';
    }

    private object(value: JsonValue | undefined): JsonObject {
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
    }

    private strings(value: JsonValue | undefined): string[] {
        return Array.isArray(value) ? value.filter((each: JsonValue): each is string => typeof each === 'string') : [];
    }
}
