import { ApiConnectionError } from '@webpieces/core-util';

/**
 * The `cause` of an {@link ApiConnectionError} minted from a service worker's synthetic 504 — it
 * carries the `Response` itself, so a reporter or a debugger can see exactly what came back.
 * An `Error` only because `ApiError`'s `cause` is typed `Error`; it is never thrown on its own.
 */
export class ServiceWorkerSyntheticResponseError extends Error {
    constructor(public readonly response: Response) {
        super(
            `A service worker answered with a synthetic ${response.status} ${response.statusText} ` +
                `(null body, no headers) — the network fetch behind it rejected`,
        );
        this.name = 'ServiceWorkerSyntheticResponseError';
    }
}

/**
 * Recognises the response Angular's service worker fabricates when its own network fetch rejects
 * (#1293): `new Response(null, { status: 504, statusText: 'Gateway Timeout' })` from
 * `Driver.safeFetch`. That shape is EXACT — status 504, statusText `Gateway Timeout`, a null body and
 * NO headers at all — while a real load-balancer or gateway 504 carries headers (at least a
 * `content-type` or a `date`). So a real 504 stays `ApiDependencyTimeoutError`, and only the
 * fabricated one becomes `ApiConnectionError`.
 *
 * The fallback for an app that opts out with `ServiceWorkerRouting.ALLOW`; with the default bypass,
 * ngsw never sees the call and the fetch rejects natively. It runs either way — a real response can
 * never match it.
 */
export class ServiceWorkerSyntheticResponse {
    /** True only for the exact synthetic shape; any header at all means a real server answered. */
    isSynthetic(response: Response): boolean {
        return (
            response.status === 504 &&
            response.statusText === 'Gateway Timeout' &&
            response.body === null &&
            !this.hasAnyHeader(response.headers)
        );
    }

    /**
     * Return `response` untouched, or THROW an {@link ApiConnectionError} (cause: a
     * {@link ServiceWorkerSyntheticResponseError} holding the response) when it is the synthetic one.
     */
    rejectIfSynthetic(response: Response, url: string): Response {
        if (this.isSynthetic(response)) {
            throw new ApiConnectionError(
                `Request to ${url} never reached a server (a service worker answered with its synthetic 504)`,
                new ServiceWorkerSyntheticResponseError(response),
            );
        }
        return response;
    }

    private hasAnyHeader(headers: Headers): boolean {
        for (const _entry of headers.keys()) {
            return true;
        }
        return false;
    }
}
