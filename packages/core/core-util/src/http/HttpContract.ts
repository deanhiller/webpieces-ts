import { ApiBadRequestError } from '../errors/ApiError';

/** Nominal backing keeps raw string literals out of endpoint declarations. */
enum HttpMethodValue {
    GET = 'GET',
    POST = 'POST',
}

/** Short, statically importable decorator arguments. Raw strings do not satisfy {@link HttpMethod}. */
export const GET = HttpMethodValue.GET;
export const POST = HttpMethodValue.POST;

/** HTTP verbs currently supported by generated Webpieces request/response contracts. */
export type HttpMethod = typeof GET | typeof POST;

/** Whether a generated client returns the response body or the whole transport-neutral response. */
export type EndpointResponseType = 'body' | 'full';

/** The wire source for one explicitly mapped scalar/list method parameter. */
export type HttpParameterSource = 'path' | 'query';

/** Runtime conversion supported for path/query values after TypeScript design metadata is read. */
export type HttpParameterValueType = 'string' | 'number' | 'boolean' | 'array' | 'unknown';

/** Concrete runtime values produced for path/query parameters. */
type ConvertedHttpParameter = string | number | boolean | readonly string[];

/** Metadata written by `@PathParam` / `@QueryParam` before route construction knows the value type. */
export class HttpParameterDeclaration {
    constructor(
        public readonly index: number,
        public readonly source: HttpParameterSource,
        public readonly wireName: string,
    ) {}
}

/** Fully resolved parameter metadata carried by every server and client route. */
export class HttpParameterBinding extends HttpParameterDeclaration {
    constructor(
        index: number,
        source: HttpParameterSource,
        wireName: string,
        public readonly valueType: HttpParameterValueType,
    ) {
        super(index, source, wireName);
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

    // webpieces-disable no-function-outside-class -- private pure helper for the static wire mapper
    private static convert(
        binding: HttpParameterBinding,
        raw: string | readonly string[],
    ): ConvertedHttpParameter {
        const values = Array.isArray(raw) ? raw : [raw];
        if (binding.valueType === 'array') return [...values];
        if (values.length !== 1) {
            throw new ApiBadRequestError(
                `Parameter '${binding.wireName}' was repeated but is not declared as an array.`,
            );
        }
        const value = values[0];
        switch (binding.valueType) {
            case 'string':
            case 'unknown':
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
