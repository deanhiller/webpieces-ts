import { Response } from 'express';
import { RouterResponse } from '@webpieces/http-routing';

/**
 * ExpressRouterResponse - Express implementation of RouterResponse interface.
 *
 * Bridges Express Response to the RouterResponse abstraction,
 * allowing filters to write responses without depending on Express directly.
 */
export class ExpressRouterResponse implements RouterResponse {
    private res: Response;

    constructor(res: Response) {
        this.res = res;
    }

    /**
     * Set HTTP status code.
     */
    setStatus(code: number): void {
        this.res.status(code);
    }

    /**
     * Set a response header.
     */
    setHeader(name: string, value: string): void {
        this.res.setHeader(name, value);
    }

    /**
     * Send response body and end the response.
     */
    send(body: string): void {
        this.res.send(body);
    }

    /**
     * Check if headers have already been sent.
     */
    isHeadersSent(): boolean {
        return this.res.headersSent;
    }

    /**
     * Get the underlying Express response.
     * Use sparingly - prefer using RouterResponse interface methods.
     */
    getUnderlyingResponse(): Response {
        return this.res;
    }
}
