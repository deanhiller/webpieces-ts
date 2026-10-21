import { ApiBadRequestError } from '../errors/ApiError';
import { QueryParams } from './QueryParams';

/** Nominal backing keeps raw string literals out of endpoint declarations. */
enum HttpMethodValue {
    GET = 'GET',
    POST = 'POST',
    PUT = 'PUT',
    PATCH = 'PATCH',
    DELETE = 'DELETE',
}

/** Short, statically importable decorator arguments. Raw strings do not satisfy {@link HttpMethod}. */
export const GET = HttpMethodValue.GET;
export const POST = HttpMethodValue.POST;
export const PUT = HttpMethodValue.PUT;
export const PATCH = HttpMethodValue.PATCH;
export const DELETE = HttpMethodValue.DELETE;

/** HTTP verbs supported by generated Webpieces request/response contracts. */
export type HttpMethod = typeof GET | typeof POST | typeof PUT | typeof PATCH | typeof DELETE;

/** Every verb, in declaration order — the one list validators and messages enumerate. */
export const HTTP_METHODS: readonly HttpMethod[] = [GET, POST, PUT, PATCH, DELETE];

/**
 * The ONE rule for "may this verb carry a request body": POST, PUT and PATCH do; GET and DELETE do
 * not. Every client serializer, route validator, scanner and document renderer asks this, instead of
 * each re-deciding it with its own `=== 'POST'` check (which is how a sixth copy drifts).
 */
// webpieces-disable no-function-outside-class -- pure predicate shared by DI-free browser and server runtimes
export function verbCarriesBody(method: string): boolean {
    return method === POST || method === PUT || method === PATCH;
}

/** Runtime backstop for JavaScript and `as any` callers of `@Endpoint`. */
// webpieces-disable no-function-outside-class -- pure guard shared by decorators and readers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an HTTP method
export function isHttpMethod(value: unknown): value is HttpMethod {
    return (HTTP_METHODS as readonly unknown[]).includes(value);
}

/** Whether a generated client returns the response body or the whole transport-neutral response. */
export type EndpointResponseType = 'body' | 'full';

/**
 * The wire source for one explicitly mapped method parameter: a `{placeholder}`, one named query key,
 * or (`@QueryString()`, EXTERNAL_OUTBOUND contracts only) the whole query string as a {@link QueryParams}.
 */
export type HttpParameterSource = 'path' | 'query' | 'query-map';

/**
 * The ITEM type of a list query parameter, declared as `@QueryParam('ids', Number)`: TypeScript's
 * design metadata erases `number[]` to `Array`, so without it every item arrives as a string.
 */
export type HttpQueryItemType = typeof String | typeof Number | typeof Boolean;

/** Runtime conversion supported for path/query values after TypeScript design metadata is read. */
export type HttpParameterValueType = 'string' | 'number' | 'boolean' | 'array' | 'unknown';

/** Concrete runtime values produced for path/query parameters. */
type ConvertedHttpParameter =
    | string
    | number
    | boolean
    | readonly string[]
    | readonly number[]
    | readonly boolean[]
    | QueryParams;

/** Metadata written by `@PathParam` / `@QueryParam` before route construction knows the value type. */
export class HttpParameterDeclaration {
    constructor(
        public readonly index: number,
        public readonly source: HttpParameterSource,
        /** The wire name; `''` for a `query-map`, which binds every key. */
        public readonly wireName: string,
        /** `@QueryParam('ids', Number)`: the item type of a list query parameter. */
        public readonly itemType?: HttpQueryItemType,
    ) {}
}

/** Fully resolved parameter metadata carried by every server and client route. */
export class HttpParameterBinding extends HttpParameterDeclaration {
    constructor(
        index: number,
        source: HttpParameterSource,
        wireName: string,
        public readonly valueType: HttpParameterValueType,
        itemType?: HttpQueryItemType,
    ) {
        super(index, source, wireName, itemType);
    }
}

/** Result of mapping one API method call to its HTTP path/query/body. */
export class BoundHttpRequest {
    constructor(
        public readonly path: string,
        // webpieces-disable no-any-unknown -- the contract owns the request body type
        public readonly body: unknown,
    ) {}
}

/**
 * The single path/query/body mapper shared by generated clients and the incoming server adapter.
 * Java Webpieces' `HttpsJsonClientInvokeHandler` is the reference model: explicit wire names,
 * encoded placeholders, omitted null query values, and repeated list keys. This port deliberately
 * fixes Java's list-query overwrite bug and never depends on compiled JavaScript parameter names.
 */
export class HttpContractMapper {
    /** API arguments -> encoded relative URL + body. */
    // webpieces-disable no-function-outside-class -- pure cross-runtime mapper used by DI-free browser clients and server adapters
    static toWire(
        pathTemplate: string,
        bindings: readonly HttpParameterBinding[],
        bodyParameterIndex: number | undefined,
        // webpieces-disable no-any-unknown -- arbitrary API method parameters cross this generic boundary
        args: readonly unknown[],
    ): BoundHttpRequest {
        let path = pathTemplate;
        const query: string[] = [];

        for (const binding of bindings) {
            const value = args[binding.index];
            if (binding.source === 'path') {
                if (value === undefined || value === null) {
                    throw new ApiBadRequestError(
                        `Missing path parameter '${binding.wireName}' at argument ${binding.index}.`,
                    );
                }
                const token = `{${binding.wireName}}`;
                path = path.split(token).join(encodeURIComponent(String(value)));
                continue;
            }

            if (value === undefined || value === null) continue;
            if (binding.source === 'query-map') {
                this.appendQueryMap(binding, value, query);
                continue;
            }
            const values = Array.isArray(value) ? value : [value];
            for (const item of values) {
                if (item === undefined || item === null) continue;
                query.push(
                    `${encodeURIComponent(binding.wireName)}=${encodeURIComponent(String(item))}`,
                );
            }
        }

        if (/\{[^{}]+\}/.test(path)) {
            throw new ApiBadRequestError(
                `Not every path placeholder was supplied for '${pathTemplate}'.`,
            );
        }
        const suffix =
            query.length === 0 ? '' : `${path.includes('?') ? '&' : '?'}${query.join('&')}`;
        return new BoundHttpRequest(
            `${path}${suffix}`,
            bodyParameterIndex === undefined ? undefined : args[bodyParameterIndex],
        );
    }

    /** One `@QueryString()` argument -> repeated `key=value` pairs, in insertion order. */
    // webpieces-disable no-function-outside-class -- private pure helper for the static wire mapper; webpieces-disable no-any-unknown -- the argument's type is erased at the generic boundary
    private static appendQueryMap(binding: HttpParameterBinding, value: unknown, query: string[]): void {
        if (!(value instanceof QueryParams)) {
            throw new ApiBadRequestError(
                `Argument ${binding.index} is @QueryString() and must be a QueryParams, received ${typeof value}.`,
            );
        }
        for (const key of value.keys()) {
            for (const item of value.getAll(key)) {
                query.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
            }
        }
    }

    /** Decoded path/query/body -> API arguments in declaration order. */
    // webpieces-disable no-function-outside-class -- pure inverse mapper paired with toWire
    static fromWire(
        bindings: readonly HttpParameterBinding[],
        bodyParameterIndex: number | undefined,
        // webpieces-disable no-any-unknown -- the contract owns the request body type
        body: unknown,
        pathValues: ReadonlyMap<string, string | readonly string[]>,
        queryValues: ReadonlyMap<string, string | readonly string[]>,
    ): unknown[] {
        const highestBinding = bindings.reduce(
            (highest: number, binding: HttpParameterBinding) => Math.max(highest, binding.index),
            -1,
        );
        const argCount = Math.max(highestBinding, bodyParameterIndex ?? -1) + 1;
        // webpieces-disable no-any-unknown -- API argument types are erased at the shared wire boundary
        const args = new Array<unknown>(argCount);
        if (bodyParameterIndex !== undefined) args[bodyParameterIndex] = body;

        for (const binding of bindings) {
            if (binding.source === 'query-map') {
                args[binding.index] = this.queryMapOf(queryValues);
                continue;
            }
            const values = binding.source === 'path' ? pathValues : queryValues;
            const raw = values.get(binding.wireName);
            if (raw === undefined) {
                if (binding.source === 'path') {
                    throw new ApiBadRequestError(`Missing path parameter '${binding.wireName}'.`);
                }
                args[binding.index] = undefined;
                continue;
            }
            args[binding.index] = this.convert(binding, raw);
        }
        return args;
    }

    /** Every decoded query key -> a {@link QueryParams}, the inverse of {@link appendQueryMap}. */
    // webpieces-disable no-function-outside-class -- private pure helper for the static wire mapper
    private static queryMapOf(queryValues: ReadonlyMap<string, string | readonly string[]>): QueryParams {
        const params = new QueryParams();
        for (const entry of queryValues.entries()) {
            const raw = entry[1];
            for (const item of Array.isArray(raw) ? raw : [raw]) params.add(entry[0], item);
        }
        return params;
    }

    // webpieces-disable no-function-outside-class -- private pure helper for the static wire mapper
    private static convert(
        binding: HttpParameterBinding,
        raw: string | readonly string[],
    ): ConvertedHttpParameter {
        const values = Array.isArray(raw) ? raw : [raw];
        if (binding.valueType === 'array') return this.convertItems(binding, values);
        if (values.length !== 1) {
            throw new ApiBadRequestError(
                `Parameter '${binding.wireName}' was repeated but is not declared as an array.`,
            );
        }
        const value = values[0];
        return this.convertScalar(binding, value);
    }

    /** A list query parameter's items, as its declared item type (`@QueryParam('ids', Number)`). */
    // webpieces-disable no-function-outside-class -- private pure helper for the static wire mapper
    private static convertItems(
        binding: HttpParameterBinding,
        values: readonly string[],
    ): readonly string[] | readonly number[] | readonly boolean[] {
        if (binding.itemType === Number) {
            return values.map((item: string) => this.convertScalar(binding, item, 'number') as number);
        }
        if (binding.itemType === Boolean) {
            return values.map((item: string) => this.convertScalar(binding, item, 'boolean') as boolean);
        }
        return [...values];
    }

    // webpieces-disable no-function-outside-class -- private pure helper for the static wire mapper
    private static convertScalar(
        binding: HttpParameterBinding,
        value: string,
        valueType: HttpParameterValueType = binding.valueType,
    ): string | number | boolean {
        switch (valueType) {
            case 'string':
            case 'unknown':
            case 'array':
                return value;
            case 'number': {
                if (value.trim() === '') {
                    throw new ApiBadRequestError(
                        `Parameter '${binding.wireName}' must be a number.`,
                    );
                }
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) {
                    throw new ApiBadRequestError(
                        `Parameter '${binding.wireName}' must be a number.`,
                    );
                }
                return parsed;
            }
            case 'boolean':
                if (value === 'true') return true;
                if (value === 'false') return false;
                throw new ApiBadRequestError(
                    `Parameter '${binding.wireName}' must be 'true' or 'false'.`,
                );
        }
    }
}
