import { ApiBadRequestError } from '../errors/ApiError';

/** One query value as a caller may supply it. Sent as its string form. */
export type QueryParamValue = string | number | boolean;

/**
 * A free-form query string: a multimap of key -> values, after Java webpieces'
 * `RouterRequest.queryParams` (`Map<String, List<String>>`). It is the ONE spelling of query
 * parameters on an `EXTERNAL_OUTBOUND` contract, through `@QueryString() query: QueryParams` — a
 * vendor's query grammar is the vendor's (a vendor may document `filter` as one string yet repeat it on
 * the wire), so the contract does not pretend to type it. Our own contracts keep the typed
 * `@QueryParam('name')` instead.
 *
 * ```ts
 * getItems(@PathParam('mId') mId: string, @QueryString() query: QueryParams): Promise<ItemsDto>
 * ```
 *
 * ```ts
 * vendorApi.getItems(mId, new QueryParams().add('filter', 'a').add('filter', 'b').set('limit', 100));
 * // -> ?filter=a&filter=b&limit=100
 * ```
 *
 * Keys keep their insertion order, and so do a key's values, so the wire is deterministic.
 */
export class QueryParams {
    private readonly values = new Map<string, string[]>();

    /** Append one value to `key` — call it again to REPEAT the key (`a=1&a=2`). */
    add(key: string, value: QueryParamValue): QueryParams {
        const existing = this.values.get(key) ?? [];
        existing.push(String(value));
        this.values.set(key, existing);
        return this;
    }

    /** Replace every value of `key` with exactly this one. */
    set(key: string, value: QueryParamValue): QueryParams {
        this.values.set(key, [String(value)]);
        return this;
    }

    /** Every value of `key`, in order; empty when the key is absent. */
    getAll(key: string): string[] {
        return [...(this.values.get(key) ?? [])];
    }

    /**
     * The ONE value of `key`, or undefined when it is absent.
     * @throws ApiBadRequestError (400) when the key is repeated: a single value was expected.
     */
    getSingle(key: string): string | undefined {
        const all = this.values.get(key);
        if (all === undefined || all.length === 0) return undefined;
        if (all.length > 1) {
            throw new ApiBadRequestError(`Query parameter '${key}' was repeated but a single value is expected.`);
        }
        return all[0];
    }

    /**
     * {@link getSingle}, as a finite number.
     * @throws ApiBadRequestError (400) when the value is repeated or not a number.
     */
    getNumber(key: string): number | undefined {
        const value = this.getSingle(key);
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (value.trim() === '' || !Number.isFinite(parsed)) {
            throw new ApiBadRequestError(`Query parameter '${key}' must be a number.`);
        }
        return parsed;
    }

    /**
     * {@link getSingle}, as `true` / `false`.
     * @throws ApiBadRequestError (400) when the value is repeated or not 'true' / 'false'.
     */
    getBoolean(key: string): boolean | undefined {
        const value = this.getSingle(key);
        if (value === undefined) return undefined;
        if (value === 'true') return true;
        if (value === 'false') return false;
        throw new ApiBadRequestError(`Query parameter '${key}' must be 'true' or 'false'.`);
    }

    /** Every key, in insertion order. */
    keys(): string[] {
        return [...this.values.keys()];
    }
}
