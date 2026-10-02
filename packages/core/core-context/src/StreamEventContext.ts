import { randomUUID } from 'node:crypto';
import { WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';
import { CapturedContext } from './CapturedContext';
import { HttpRequest } from './HttpRequest';

/** Captures the authenticated opening scope and restores an isolated scope for every event. */
export class StreamEventContext {
    private readonly captured: CapturedContext;
    private readonly request?: HttpRequest;

    constructor() {
        this.captured = RequestContext.copyContext();
        const current = RequestContext.getRequest();
        if (current) this.request = this.copyRequest(current);
    }

    run<T>(handler: () => T): T {
        return RequestContext.runWithContext(this.captured.withTrusted(), () => {
            if (this.request) RequestContext.setRequest(this.copyRequest(this.request));
            RequestContext.putUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID, randomUUID());
            return handler();
        });
    }

    private copyRequest(request: HttpRequest): HttpRequest {
        const headers = new Map<string, string[]>();
        for (const entry of request.headers) headers.set(entry[0], [...entry[1]]);
        return new HttpRequest(request.method, request.path, headers, request.raw);
    }

    /** Triggered output inherits its inbound event; unsolicited output receives its own child scope. */
    runOutbound<T>(handler: () => T): T {
        if (RequestContext.getUntrusted(WebpiecesCoreHeaders.STREAM_EVENT_ID)) return handler();
        return this.run(handler);
    }
}
