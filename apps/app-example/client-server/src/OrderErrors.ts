import {
    ClientRegistry,
    ErrorTranslators,
    HttpError,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    ProtocolError,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';

/**
 * An app's OWN error type, at its OWN status code — the thing the built-in webpieces ladder cannot
 * know about, and the reason {@link ErrorTranslators} exists.
 */
export class OrderNotFoundError extends HttpError {
    constructor(public readonly orderId: string) {
        super(`no order ${orderId}`, 460);
        this.name = 'OrderNotFoundError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** The header this app puts on its own error responses — impossible before the response DTO. */
export const ORDER_SURFACE_HEADER = 'x-order-surface';

/**
 * ONE class, BOTH directions — the canonical example from issue #862. It lives in the SERVER app
 * rather than the shared api package for a boundary reason worth stating: `toWire` reads
 * `RequestContext`, which is node-only, and `client-server-api` is tagged [browser, node] so
 * `enforce-architecture` (rightly) refuses that import. A browser app that wants the same symmetry
 * ships its own `fromWire` half against the same status codes — which is exactly the seam
 * `ErrorTranslators` is: one interface, two independently-installable halves.
 *
 * `toWire` runs on the server (`ExpressWrapper.handleError`); `fromWire` runs on every client in the
 * process (`ClientErrorTranslator.translateError`). The payoff is type symmetry across the wire: the
 * server throws {@link OrderNotFoundError} and the caller CATCHES {@link OrderNotFoundError},
 * instead of every call site decoding 460 by hand.
 *
 * `toWire` deliberately branches on {@link RequestContext.getRequest}, because that is the shape that
 * used to be broken: a real app's translator asks "is this MY surface?" before claiming an error, and
 * the request was published AFTER the body parse, so a malformed body reached the translator with an
 * empty scope and it could only step aside. `ErrorTranslationSymmetry.spec.ts` pins both halves.
 */
export class OrderErrorTranslators implements ErrorTranslators {
    /** SERVER: exception -> the whole response. `undefined` => not mine, use webpieces' default. */
    toWire(error: Error): HttpResponseDto | undefined {
        const path = RequestContext.getRequest()?.path;
        if (path === undefined || !path.startsWith('/public')) {
            return undefined;
        }

        const body = new ProtocolError();
        body.message = error.message;
        body.errorCode = error instanceof OrderNotFoundError ? 'ORDER_NOT_FOUND' : 'ORDER_SURFACE_ERROR';
        // STRUCTURED, so fromWire rebuilds the exact type rather than re-parsing prose.
        body.field = error instanceof OrderNotFoundError ? error.orderId : undefined;
        const status = error instanceof OrderNotFoundError
            ? new HttpResponseStatus(460, 'Order Not Found')
            : new HttpResponseStatus(461, 'Order Surface Error');
        return new HttpResponseDto(status, [new HttpHeader(ORDER_SURFACE_HEADER, path)], body);
    }

    /** CLIENT: the whole response -> a typed exception. Same shape `toWire` produced. */
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) {
            return undefined;
        }
        const body = response.body as ProtocolError;
        return new OrderNotFoundError(body.field ?? 'unknown');
    }
}

/**
 * Install them, once per process, on the server AND in the browser. A real app calls this from its
 * startup; the example calls it from its tests so nothing else in the example changes behaviour.
 */
// webpieces-disable no-function-outside-class -- one-line startup registration, mirroring ClientRegistry's own static API
export function installOrderErrorTranslators(): void {
    ClientRegistry.setErrorTranslators(new OrderErrorTranslators());
}
