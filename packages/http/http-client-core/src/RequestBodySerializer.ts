import { ApiImplementationError, RouteMetadata } from '@webpieces/core-util';

/**
 * ONE outbound request DTO -> the bytes on the wire, in exactly the encoding the endpoint DECLARED.
 *
 * Extracted from {@link ProxyClient}, which had grown past this repo's file-size limit and was doing
 * three unrelated jobs: driving the call lifecycle, talking to the transport, and turning a DTO into
 * bytes. This is the third one, and it is the one with no dependency on any of the others — it is a
 * pure transformation of a DTO plus its route, and it is where the `formPost` encoding rules live.
 *
 * Stateless, so `ProxyClient` holds one instance for its whole life. `apiName` is passed per call
 * rather than bound at construction, because the serializer is built before the client is bound to a
 * contract and the name is only ever used to make an error message say WHICH endpoint was wrong.
 */
export class RequestBodySerializer {
    /**
     * The serialized body, or undefined when there is none — and the Content-Type header is SET here
     * rather than by the caller, because the encoding and the header that declares it are one
     * decision and splitting them is how they drift apart.
     *
     * GET is always bodyless: a GET with a body is accepted by some servers, dropped by some proxies
     * and cached wrongly by others, so the contract's declared verb settles it.
     */
    // webpieces-disable no-any-unknown -- request DTO type is erased at the generated proxy boundary
    serialize(
        apiName: string,
        route: RouteMetadata,
        requestDto: unknown,
        headers: Map<string, string>,
    ): string | undefined {
        if (route.httpMethod === 'GET' || requestDto === undefined) {
            return undefined;
        }
        if (route.formPost) {
            headers.set('Content-Type', 'application/x-www-form-urlencoded');
            return this.serializeForm(apiName, requestDto, route);
        }
        headers.set('Content-Type', 'application/json');
        return JSON.stringify(requestDto);
    }

    /**
     * Flat form DTO -> deterministic urlencoded bytes, repeating array-valued fields.
     *
     * DETERMINISTIC (the keys are sorted) because a webhook vendor that signs a form body signs the
     * bytes, so two runs of the same call have to produce the same string.
     */
    // webpieces-disable no-any-unknown -- form DTO fields are contract-owned and heterogeneous
    private serializeForm(apiName: string, requestDto: unknown, route: RouteMetadata): string {
        if (requestDto === null || typeof requestDto !== 'object' || Array.isArray(requestDto)) {
            throw new ApiImplementationError(
                `${apiName}.${route.methodName} declares formPost:true, so its body must be a flat object.`,
            );
        }
        const params = new URLSearchParams();
        // webpieces-disable no-any-unknown -- checked object is narrowed to its contract-owned field bag
        for (const key of Object.keys(requestDto as Record<string, unknown>).sort()) {
            // webpieces-disable no-any-unknown -- checked object is narrowed to its contract-owned field bag
            const value = (requestDto as Record<string, unknown>)[key];
            if (value === undefined || value === null) continue;
            const values = Array.isArray(value) ? value : [value];
            for (const item of values) {
                if (item !== undefined && item !== null) params.append(key, String(item));
            }
        }
        return params.toString();
    }
}
