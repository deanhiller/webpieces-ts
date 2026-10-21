import {
    getApiPath,
    getAuthMeta,
    getEndpointHttpMethod,
    getEndpointKind,
    getEndpointOperation,
    getEndpointOptions,
    getEndpoints,
    getMaskSpec,
} from './decorators';
import { getHttpParameterDeclarations } from './http-parameter-decorators';
import {
    EndpointResponseType,
    HttpParameterBinding,
    HttpParameterDeclaration,
    HttpParameterValueType,
    HttpMethod,
    POST,
    verbCarriesBody,
} from './HttpContract';
import { RouteMetadata } from './RouteMetadata';
import { QueryParams } from './QueryParams';
import { EndpointOptions, NONE } from './HttpEndpointOptions';
import { getStreamingEndpoint } from './StreamingContract';
import { getAuthorization } from './authorization';
import {
    assertEveryEndpointHasAuthMode,
    assertExternalEndpointKinds,
    isExternalOutboundApi,
    isLocalOnly,
} from './decorators';
import { declaresExternalContextKeys, getExternalContextKeys } from './ExternalContextKeys';
import { StreamDirection, StreamingEndpointMetadata } from './StreamingContract';

/**
 * Build the one runtime route model consumed by incoming routing, in-process clients, and both
 * generated HTTP clients. Keeping this join/validation here prevents four subtly different
 * interpretations of the same decorators.
 */
export class RouteMetadataFactory {
    // webpieces-disable no-function-outside-class -- deterministic decorator metadata factory shared by DI-free browser and server runtimes
    static create(
        apiClass: Function,
        methodName: string,
        controllerClassName?: string,
    ): RouteMetadata {
        assertEveryEndpointHasAuthMode(apiClass);
        const externalOutbound = this.externalOutbound(apiClass);
        const fullPath = this.joinPath(getApiPath(apiClass) ?? '', this.endpointPath(apiClass, methodName));
        const options = getEndpointOptions(apiClass, methodName);
        const streaming = getStreamingEndpoint(apiClass, methodName);
        const httpMethod = getEndpointHttpMethod(apiClass, methodName);
        const operation = getEndpointOperation(apiClass, methodName);
        this.validateEndpointOptions(apiClass, methodName, httpMethod, options.formPost, options.rawBody);
        this.validateTriggerVerb(apiClass, methodName, httpMethod);
        const parameterTypes = this.parameterTypes(apiClass, methodName);
        const declarations = getHttpParameterDeclarations(apiClass, methodName);
        this.validateQueryDeclarations(apiClass, methodName, externalOutbound, parameterTypes, declarations);
        const bodyParameterIndex = streaming
            ? this.validateStreamingParameters(
                  apiClass,
                  methodName,
                  httpMethod,
                  parameterTypes,
                  declarations,
                  streaming,
              )
            : this.validateParameters(
                  apiClass,
                  methodName,
                  fullPath,
                  httpMethod,
                  parameterTypes,
                  declarations,
              );
        const bindings = this.bindingsOf(declarations, parameterTypes);
        const route = new RouteMetadata(
            httpMethod,
            fullPath,
            methodName,
            operation,
            controllerClassName,
            getAuthMeta(apiClass, methodName),
            apiClass.name || 'UnknownApi',
            options.formPost === true,
            getMaskSpec(apiClass, methodName),
            options.rawBody === true,
            bindings,
            bodyParameterIndex,
            this.responseType(options.responseType, apiClass, methodName),
            streaming,
            options.hideProgress === true,
            options.noLogging === true,
            options.allowUpgradeInFlight === true,
            this.noResponseBody(options, streaming, apiClass, methodName),
        );
        route.authorization = getAuthorization(apiClass, methodName);
        route.apiClass = apiClass;
        route.localOnly = isLocalOnly(apiClass, methodName);
        route.externalOutbound = externalOutbound;
        route.externalContextKeys = getExternalContextKeys(apiClass, methodName);
        return route;
    }
    /** Each declaration resolved against its argument's reflected type, in argument order. */
    // webpieces-disable no-function-outside-class -- private pure helper for static route metadata construction
    private static bindingsOf(
        declarations: readonly HttpParameterDeclaration[],
        parameterTypes: readonly Function[],
    ): HttpParameterBinding[] {
        return declarations
            .map(
                (declaration: HttpParameterDeclaration) =>
                    new HttpParameterBinding(
                        declaration.index,
                        declaration.source,
                        declaration.wireName,
                        this.valueType(parameterTypes[declaration.index]),
                        declaration.itemType,
                    ),
            )
            .sort((a: HttpParameterBinding, b: HttpParameterBinding) => a.index - b.index);
    }

    // webpieces-disable no-function-outside-class -- private pure helper for static route metadata construction
    private static endpointPath(apiClass: Function, methodName: string): string {
        const path = (getEndpoints(apiClass) ?? {})[methodName];
        if (path !== undefined) return path;
        throw new Error(`No @Endpoint metadata for ${apiClass.name || 'Unknown'}.${methodName}.`);
    }

    // webpieces-disable no-function-outside-class -- private pure helper keeps the existing static metadata factory below the method-size limit
    private static validateEndpointOptions(
        apiClass: Function,
        methodName: string,
        httpMethod: HttpMethod,
        formPost?: boolean,
        rawBody?: boolean,
    ): void {
        if (verbCarriesBody(httpMethod)) return;
        if (formPost === true) {
            throw new Error(
                `${apiClass.name}.${methodName} is ${httpMethod} and cannot declare formPost:true because ${httpMethod} has no request body.`,
            );
        }
        if (rawBody === true) {
            throw new Error(
                `${apiClass.name}.${methodName} is ${httpMethod} and cannot declare rawBody:true because ${httpMethod} has no request body.`,
            );
        }
    }

    /**
     * A CLOUDTASKS or CRON endpoint must be POST: Cloud Tasks, Cloud Scheduler and the in-memory task
     * invoker all deliver with POST, so any other verb would register a route nothing ever reaches
     * (a 404 at delivery time, not at startup).
     */
    // webpieces-disable no-function-outside-class -- private pure validator for the static metadata factory
    private static validateTriggerVerb(apiClass: Function, methodName: string, httpMethod: HttpMethod): void {
        const kind = getEndpointKind(apiClass, methodName);
        if ((kind === 'cloudtasks' || kind === 'cron') && httpMethod !== POST) {
            throw new Error(
                `${apiClass.name || 'Unknown'}.${methodName} is a ${kind.toUpperCase()} endpoint declared ${httpMethod}; ` +
                    `task and scheduler delivery always uses POST, so declare @Endpoint(POST, ...).`,
            );
        }
    }

    // webpieces-disable no-function-outside-class -- private pure validator alongside existing contract validators
    private static validateStreamingParameters(
        apiClass: Function,
        methodName: string,
        httpMethod: HttpMethod,
        parameterTypes: readonly Function[],
        declarations: readonly HttpParameterDeclaration[],
        streaming: StreamingEndpointMetadata,
    ): number | undefined {
        const label = `${apiClass.name || 'Unknown'}.${methodName}`;
        if (
            !streaming.initialRequestSchema ||
            !streaming.initialResponseSchema ||
            (streaming.direction !== StreamDirection.RESPONSE && !streaming.requestSchema) ||
            (streaming.direction !== StreamDirection.REQUEST && !streaming.responseSchema)
        ) {
            throw new Error(
                `${label} requires generated streaming schemas. Run wp-openapi and registerStreamingCatalog(${apiClass.name}, catalog) before binding.`,
            );
        }
        if (httpMethod !== POST) throw new Error(`${label} is streaming and must use POST.`);
        if (declarations.length > 0)
            throw new Error(`${label} is streaming and cannot declare path/query parameters.`);
        const expected = streaming.direction === StreamDirection.REQUEST ? 1 : 2;
        if (parameterTypes.length !== expected) {
            const form =
                streaming.direction === StreamDirection.REQUEST
                    ? '(InitialRequest) => Promise<RequestStream<InitialResponse, RequestEvent>>'
                    : streaming.direction === StreamDirection.RESPONSE
                      ? '(InitialRequest, ResponseStream<ResponseEvent>) => Promise<InitialResponse>'
                      : '(InitialRequest, ResponseStream<ResponseEvent>) => Promise<RequestStream<InitialResponse, RequestEvent>>';
            throw new Error(
                `Invalid @WpStream(StreamDirection.${streaming.direction.toUpperCase()}) method ${label}: ` +
                    `${streaming.direction.toUpperCase()} accepts exactly ${form}.`,
            );
        }
        return 0;
    }

    /**
     * Refuse a contract in which two endpoints resolve to the same HTTP method + path.
     *
     * Empty paths are LEGAL (`@ApiPath('')` + `@Endpoint(POST, '', ...)` is how a contract says "the whole
     * destination arrives per call"), so the thing actually worth rejecting is ambiguity: two methods
     * that land on one route. On the server the second registration would silently shadow the first
     * in the route map, and on the client both would dial the same URL — neither is ever what the
     * author meant. Placeholder NAMES are ignored when comparing (`/a/{id}` and `/a/{key}` are the
     * same route to a router), `''` and `'/'` compare equal (the server serves an empty path at the
     * root), and the error names BOTH methods so the fix is obvious.
     *
     * Called by every transport that binds a whole contract (the generated clients and the server's
     * route registration), so a duplicate dies at startup however the contract is consumed.
     *
     * @throws Error naming both colliding methods and the shared route.
     */
    // webpieces-disable no-function-outside-class -- deterministic contract validation shared by DI-free browser and server runtimes
    static assertNoDuplicateRoutes(apiClass: Function): void {
        const label = apiClass.name || 'Unknown';
        const seen = new Map<string, string>();
        for (const methodName of Object.keys(getEndpoints(apiClass) ?? {})) {
            const route = this.create(apiClass, methodName);
            // '' and '/' are one route to a server (every request path starts with '/').
            const shape = (route.path === '' ? '/' : route.path).replace(/\{[^{}]+\}/g, '{}');
            const key = `${route.httpMethod} ${shape}`;
            const previous = seen.get(key);
            if (previous !== undefined) {
                throw new Error(
                    `${label}.${previous} and ${label}.${methodName} both resolve to ` +
                        `${route.httpMethod} '${route.path}'. Two endpoints of one contract cannot share ` +
                        `an HTTP method + path; give one of them a distinct @Endpoint path or HTTP method.`,
                );
            }
            seen.set(key, methodName);
        }
    }

    /**
     * Join `@ApiPath` and `@Endpoint` into the route path.
     *
     * Both empty joins to `''`, NOT `'/'`. A contract declaring `@ApiPath('')` + `@Endpoint(POST, '', ...)`
     * is saying "this route adds nothing to the base URL", and a client whose base URL is a full
     * destination (host + path + query) must send it byte for byte. Before #926 the client joined with
     * plain concatenation (`'' + ''`), and forcing a `/` here broke exactly that (#944).
     */
    // webpieces-disable no-function-outside-class -- private pure helper for the static metadata factory
    private static joinPath(basePath: string, endpointPath: string): string {
        if (basePath === '' && endpointPath === '') return '';
        const joined = `${basePath}/${endpointPath}`.replace(/\/{2,}/g, '/');
        return joined.startsWith('/') ? joined : `/${joined}`;
    }

    // webpieces-disable no-function-outside-class -- private pure helper for the static metadata factory
    private static responseType(
        value: EndpointResponseType | undefined,
        apiClass: Function,
        methodName: string,
    ): EndpointResponseType {
        const responseType = value ?? 'body';
        if (responseType === 'body' || responseType === 'full') return responseType;
        throw new Error(
            `${apiClass.name}.${methodName} declares unsupported responseType '${String(responseType)}'; use body or full.`,
        );
    }

    /**
     * The EXTERNAL_* rules ({@link assertExternalEndpointKinds}), then whether the contract is an
     * outside system's API. `@ExternalContextKeys` says which context an OUTSIDE system may see, so it
     * is refused on a contract this repo serves, which already receives the platform context.
     */
    // webpieces-disable no-function-outside-class -- private pure validator for the static metadata factory
    private static externalOutbound(apiClass: Function): boolean {
        assertExternalEndpointKinds(apiClass);
        const externalOutbound = isExternalOutboundApi(apiClass);
        if (!externalOutbound && declaresExternalContextKeys(apiClass)) {
            throw new Error(
                `${apiClass.name || 'Unknown'} declares @ExternalContextKeys but is not an EXTERNAL_OUTBOUND contract. ` +
                    'The list says which context an OUTSIDE system may see; a contract served in this repo already ' +
                    'receives the platform context.',
            );
        }
        return externalOutbound;
    }

    /**
     * `@QueryString()` (a free-form {@link QueryParams}) is the query spelling of an EXTERNAL_OUTBOUND
     * contract ONLY — our own contracts keep the typed `@QueryParam` — and its argument must BE a
     * `QueryParams`. An item type (`@QueryParam('ids', Number)`) only means something on a list.
     */
    // webpieces-disable no-function-outside-class -- private pure validator for the static metadata factory
    private static validateQueryDeclarations(
        apiClass: Function,
        methodName: string,
        externalOutbound: boolean,
        parameterTypes: readonly Function[],
        declarations: readonly HttpParameterDeclaration[],
    ): void {
        const label = `${apiClass.name || 'Unknown'}.${methodName}`;
        for (const declaration of declarations) {
            const type = parameterTypes[declaration.index];
            if (declaration.source === 'query-map' && !externalOutbound) {
                throw new Error(
                    `${label} declares @QueryString(), which only an EXTERNAL_OUTBOUND contract may use — a vendor's ` +
                        `query string is free-form. A contract this repo serves names each key: @QueryParam('name').`,
                );
            }
            if (declaration.source === 'query-map' && type !== undefined && type !== QueryParams) {
                throw new Error(`${label} argument ${declaration.index} is @QueryString() and must be typed QueryParams.`);
            }
            if (declaration.itemType !== undefined && type !== undefined && type !== Array) {
                throw new Error(
                    `${label} @QueryParam('${declaration.wireName}', ${declaration.itemType.name}) names an item type, ` +
                        `but argument ${declaration.index} is not a list.`,
                );
            }
        }
    }

    /**
     * `responseBody: NONE` means the success response is 0 bytes, so it cannot combine with a
     * caller-owned full response or a streaming endpoint (both of which DEFINE a response).
     */
    // webpieces-disable no-function-outside-class -- private pure helper for the static metadata factory
    private static noResponseBody(
        options: EndpointOptions,
        streaming: StreamingEndpointMetadata | undefined,
        apiClass: Function,
        methodName: string,
    ): boolean {
        if (options.responseBody === undefined) return false;
        const label = `${apiClass.name || 'Unknown'}.${methodName}`;
        if (options.responseBody !== NONE) {
            throw new Error(
                `${label} declares unsupported responseBody '${String(options.responseBody)}'; the only value is NONE.`,
            );
        }
        if (options.responseType === 'full' || streaming !== undefined) {
            throw new Error(
                `${label} declares responseBody: NONE together with ${streaming ? 'a stream' : "responseType: 'full'"}; ` +
                    'a 0-byte response cannot also carry a caller-owned or streamed response.',
            );
        }
        return true;
    }

    // webpieces-disable no-function-outside-class -- Reflect metadata lookup has no injectable dependency
    private static parameterTypes(apiClass: Function, methodName: string): Function[] {
        return Reflect.getMetadata('design:paramtypes', apiClass.prototype, methodName) ?? [];
    }

    // webpieces-disable no-function-outside-class -- private deterministic contract validation helper
    private static validateParameters(
        apiClass: Function,
        methodName: string,
        fullPath: string,
        httpMethod: HttpMethod,
        parameterTypes: readonly Function[],
        declarations: readonly HttpParameterDeclaration[],
    ): number | undefined {
        const label = `${apiClass.name || 'Unknown'}.${methodName}`;
        const placeholders = [...fullPath.matchAll(/\{([^{}]+)\}/g)].map(
            (match: RegExpMatchArray) => match[1],
        );
        const pathNames = declarations
            .filter((declaration: HttpParameterDeclaration) => declaration.source === 'path')
            .map((declaration: HttpParameterDeclaration) => declaration.wireName);
        for (const placeholder of new Set(placeholders)) {
            if (!pathNames.includes(placeholder)) {
                throw new Error(
                    `${label} path '${fullPath}' contains {${placeholder}} but no @PathParam('${placeholder}') parameter.`,
                );
            }
        }
        for (const pathName of pathNames) {
            if (!placeholders.includes(pathName)) {
                throw new Error(
                    `${label} declares @PathParam('${pathName}') but '${fullPath}' has no {${pathName}} placeholder.`,
                );
            }
        }

        const seenWire = new Set<string>();
        const mappedIndexes = new Set<number>();
        for (const declaration of declarations) {
            const wireKey = `${declaration.source}:${declaration.wireName}`;
            if (seenWire.has(wireKey)) {
                throw new Error(`${label} maps '${wireKey}' more than once.`);
            }
            seenWire.add(wireKey);
            mappedIndexes.add(declaration.index);
        }

        const declaredCount = Math.max(
            parameterTypes.length,
            declarations.reduce(
                (highest: number, declaration: HttpParameterDeclaration) =>
                    Math.max(highest, declaration.index + 1),
                0,
            ),
        );
        const unbound: number[] = [];
        for (let index = 0; index < declaredCount; index++) {
            if (!mappedIndexes.has(index)) unbound.push(index);
        }
        if (!verbCarriesBody(httpMethod) && unbound.length > 0) {
            throw new Error(
                `${label} is ${httpMethod}, so every parameter must use @PathParam(...) or @QueryParam(...); argument ${unbound[0]} is unmapped.`,
            );
        }
        if (unbound.length > 1) {
            throw new Error(
                `${label} has ${unbound.length} unmapped parameters. ${httpMethod} permits exactly one unannotated request body; map every other parameter explicitly.`,
            );
        }
        return unbound[0];
    }

    // webpieces-disable no-function-outside-class -- private conversion of reflected constructors to wire types
    private static valueType(type: Function | undefined): HttpParameterValueType {
        if (type === String) return 'string';
        if (type === Number) return 'number';
        if (type === Boolean) return 'boolean';
        if (type === Array) return 'array';
        return 'unknown';
    }
}
