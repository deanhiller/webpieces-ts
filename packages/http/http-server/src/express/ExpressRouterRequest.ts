import { Request } from 'express';
import { RouterRequest } from '@webpieces/http-routing';

/**
 * ExpressRouterRequest - Express implementation of RouterRequest interface.
 *
 * Bridges Express Request to the RouterRequest abstraction,
 * allowing filters to work without depending on Express directly.
 */
export class ExpressRouterRequest implements RouterRequest {
    private req: Request;
    private headerCache: Map<string, string> | null = null;

    constructor(req: Request) {
        this.req = req;
    }

    /**
     * Get all HTTP headers as a Map.
     * Header names are lowercase per HTTP spec.
     */
    getHeaders(): Map<string, string> {
        if (this.headerCache) {
            return this.headerCache;
        }

        // Cache headers for efficiency
        this.headerCache = new Map<string, string>();

        // Express stores headers in req.headers as Record<string, string | string[]>
        for (const [name, value] of Object.entries(this.req.headers)) {
            if (typeof value === 'string') {
                this.headerCache.set(name.toLowerCase(), value);
            } else if (Array.isArray(value)) {
                // If multiple values, join with comma (HTTP spec)
                this.headerCache.set(name.toLowerCase(), value.join(', '));
            }
        }

        return this.headerCache;
    }

    /**
     * Get a single header value by name (case-insensitive).
     */
    getSingleHeaderValue(headerName: string): string | undefined {
        const headers = this.getHeaders();
        return headers.get(headerName.toLowerCase());
    }

    /**
     * Get the HTTP method (GET, POST, PUT, DELETE, etc.).
     */
    getMethod(): string {
        return this.req.method;
    }

    /**
     * Get the request path (e.g., '/api/users').
     */
    getPath(): string {
        return this.req.path;
    }

    /**
     * Read the request body as text.
     * Reads from Express request stream.
     *
     * Implements RouterRequest.readBody() interface method.
     */
    readBody(): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            this.req.on('data', (chunk) => {
                body += chunk.toString();
            });
            this.req.on('end', () => {
                resolve(body);
            });
            this.req.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Get the underlying Express request.
     * Use sparingly - prefer using RouterRequest interface methods.
     */
    getUnderlyingRequest(): Request {
        return this.req;
    }
}
