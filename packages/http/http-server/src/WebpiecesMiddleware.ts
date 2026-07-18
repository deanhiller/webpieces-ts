import { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import { provideFrameworkSingleton, WebpiecesConfig } from '@webpieces/http-routing';
import { toError } from '@webpieces/core-util';
import { RequestContextHeaders } from '@webpieces/core-context';
import { LogManager } from '@webpieces/core-util';
import { ExpressWrapper } from './ExpressWrapper';

const log = LogManager.getLogger('WebpiecesMiddleware');
// CORS mount/allow/block lines log under their own name (not [WebpiecesMiddleware]); the backend
// prepends "[CORS]" for us, so the message strings below carry no literal prefix of their own.
const corsLog = LogManager.getLogger('CORS');

/**
 * Express route handler function type. Lives in http-server (the express adapter),
 * NOT in the node-only http-routing package, so http-routing stays express-free.
 * Used by WebpiecesExpressRouter to register handlers Express can call.
 */
export type ExpressRouteHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
) => Promise<void>;

/**
 * WebpiecesMiddleware - Express middleware for WebPieces server.
 *
 * This class contains all Express middleware used by WebpiecesServer:
 * 1. errorHandler - Top-level 4-arg error middleware, returns HTML 500 page. Mounted AFTER the
 *    routes so express can forward downstream failures to it (express routes errors DOWN a
 *    separate pipeline, it does not bubble them back up through next()). Last-resort net only:
 *    api routes translate their own errors to JSON inside the filter chain (ExpressWrapper).
 * 2. corsMiddleware - Opt-in CORS (mounted only when corsOrigins is non-empty).
 *
 * Per-request logging is intentionally NOT here — the api filter chain's LogApiCall already logs
 * every request/response with full context (requestId, method, path, body), so a plain express
 * START/END line would only duplicate it with less information.
 *
 * Route dispatch happens via Express's registered route handlers (the per-route ExpressWrapper),
 * NOT via this middleware.
 *
 * NEW: ExpressWrapper simplified - no longer handles JSON or headers
 * - JSON parsing/serialization moved to JsonFilter
 * - Header transfer moved to ContextFilter (injects PlatformHeadersExtension directly)
 * - ExpressWrapper just creates RouterReqResp and invokes filter chain
 *
 * Extension vs Plugin pattern:
 * - Extensions (DI-level): Contribute capabilities to framework (headers, converters, etc.)
 * - Plugins (App-level): Provide complete features with modules + routes (Hibernate, Jackson, etc.)
 */
@provideFrameworkSingleton()
export class WebpiecesMiddleware {
    /** The ONE wire<->context transfer, handed to every route's ExpressWrapper. Stateless. */
    private readonly headers = new RequestContextHeaders();


    /**
     * Top-level error handler — the last-ditch catch-all. MUST be mounted AFTER all routes (see
     * {@link WebpiecesExpressRouter}). The 4-argument `(err, req, res, next)` signature is what
     * tells express this is an error-handling middleware: express's router forwards ANY downstream
     * failure to it — synchronous throws AND rejected async-handler promises alike (the router does
     * `promise.then(null, err => next(err))`, and a `next(err)` with a truthy arg jumps straight to
     * the first 4-arg middleware). This is why a `try { await next() } catch` wrapper is NOT needed
     * (and would not work) — express `next()` is not promise-aware, so it never hands the parent the
     * downstream promise; errors travel down this separate pipeline instead of bubbling back up.
     *
     * Returns an HTML 500 page. Api routes translate their own errors to JSON inside the filter
     * chain (JsonFilter/ExpressWrapper), so this normally only fires for failures OUTSIDE a route
     * (body parsing, unmatched paths, a bug in the wrapper itself).
     */
    // webpieces-disable no-any-unknown -- a thrown/forwarded express error is genuinely unknown until narrowed
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- express needs the 4-arg (err,req,res,next) arity to recognize this as error-handling middleware
    errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
        const error = toError(err);
        log.error(`Unhandled error: ${req.method} ${req.path}`, error);
        if (res.headersSent) {
            return;
        }
        // Return HTML error page (not JSON - api routes translate JSON errors in their filter chain)
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Server Error</title></head>
          <body>
            <h1>You hit a server error</h1>
            <p>An unexpected error occurred while processing your request.</p>
            <pre>${error.message}</pre>
          </body>
          </html>
        `);
    }

    /**
     * CORS middleware. DO NOT MOUNT UNCONDITIONALLY — {@link WebpiecesExpressRouter.bindAndStartExpress}
     * mounts it ONLY when {@link WebpiecesConfig.corsOrigins} is non-empty, and that is the point.
     *
     * CORS exists solely to let a browser on a DIFFERENT origin call this api — in practice
     * `ng serve` on :4200 hitting an api on :8080 during development, or a UI hosted on a different
     * host than the api. A server that serves its own browser app needs NO cors at all, because a
     * browser does not apply cors to a same-origin request. So in production this middleware is
     * normally ABSENT, and absent is the safe state: every origin it allows gains the right to make
     * CREDENTIALED cross-origin calls and READ the responses. Mounting it unconditionally (as the
     * old corsForLocalhost did) handed that right to anything on the victim's localhost, in prod,
     * for no benefit whatsoever.
     *
     * When mounted, allows: a request with NO Origin (curl, server-to-server, a CLI); the server's
     * OWN origin; and EXACTLY the origins in `corsOrigins` — nothing is implicit. Anything else gets
     * a clean 403, never the HTML 500 the old `callback(new Error(...))` produced.
     *
     * SAME-ORIGIN MUST STAY ALLOWED even though a same-origin request needs no cors headers, because
     * a browser attaches an `Origin` header to EVERY POST — including a same-origin POST — and every
     * webpieces route is a POST. Once mounted, this middleware SEES that origin, so if it did not
     * allow it, it would 403 the server's own UI. That was the production bug.
     *
     * The same-origin test compares HOST ONLY, deliberately. Behind a TLS-terminating proxy (Cloud
     * Run, any load balancer) `req.protocol` is `http` while the browser's `Origin` says `https`, so
     * comparing full origins would reject the server's own origin on every deploy.
     *
     * @returns Express middleware handler for CORS
     */
    corsMiddleware(config?: WebpiecesConfig): RequestHandler {
        const allowedOrigins = config?.corsOrigins ?? [];
        corsLog.info(
            `CORS MOUNTED. Allowing same-origin + [${allowedOrigins.join(', ')}]. ` +
                `Every other browser origin gets a 403.`,
        );

        const handler = cors({
            origin: true, // reflect the request origin — we have already vetted it below
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
            allowedHeaders: '*',
            exposedHeaders: '*',
            maxAge: 3600,
        });

        return (req: Request, res: Response, next: NextFunction): void => {
            const origin = req.headers.origin;
            if (!origin) {
                // No Origin -> not a browser cross-origin request; nothing to negotiate.
                next();
                return;
            }
            if (this.isOriginAllowed(origin, req.get('host'), allowedOrigins)) {
                handler(req, res, next);
                return;
            }
            corsLog.info(`Blocked origin: ${origin}`);
            res.status(403).json({
                name: 'CorsError',
                message: `CORS not allowed for origin: ${origin}`,
            });
        };
    }

    /**
     * Same-origin (HOST ONLY — see corsMiddleware() on why the scheme is deliberately ignored), or an
     * explicit entry in corsOrigins. NOTHING is implicit: localhost is allowed only if the config
     * asked for it, so a production server that enables cors for a cross-host UI does not silently
     * open the door to localhost as well.
     */
    private isOriginAllowed(origin: string, host: string | undefined, allowedOrigins: string[]): boolean {
        let originHost: string;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a malformed Origin is untrusted browser input, not a server fault; it must become a 403 here, never bubble to the 500 chokepoint
        try {
            originHost = new URL(origin).host;
        } catch (err: unknown) {
            const error = toError(err);
            corsLog.info(`Malformed Origin header '${origin}': ${error.message}`);
            return false;
        }
        if (host !== undefined && originHost === host) {
            return true; // same-origin: the server's own UI calling its own api
        }
        return allowedOrigins.some((allowed: string): boolean => this.matchesOrigin(origin, allowed));
    }

    /**
     * Exact origin match, except a `*` in the PORT position matches any port: `http://localhost:*`
     * is what a developer writes, because the angular dev-server port moves around.
     *
     * The `*` is deliberately NOT a general wildcard — it never spans a host, and what follows the
     * prefix must be a real (digits-only) port. So `http://localhost:*` cannot be tricked into
     * matching `http://localhost.evil.com`, and a bare `*` matches nothing at all.
     */
    private matchesOrigin(origin: string, allowed: string): boolean {
        if (allowed === origin) {
            return true;
        }
        const wildcardSuffix = ':*';
        if (!allowed.endsWith(wildcardSuffix)) {
            return false;
        }
        const prefix = allowed.slice(0, -wildcardSuffix.length);
        if (!origin.startsWith(`${prefix}:`)) {
            return false;
        }
        const port = origin.slice(prefix.length + 1);
        return /^\d+$/.test(port);
    }

    /**
     * Create an ExpressWrapper for a route.
     * The wrapper handles the full request/response cycle (symmetric design): it publishes the
     * HttpRequest + fills the context, then invokes the api client method (the proxy).
     *
     * @param clientMethod - The api client's method for this route (dto → response); the proxy
     *   runs the filter chain + controller.
     * @param path - The route path (used to build the HttpRequest).
     * @param formPost - True for an @Endpoint(..., { formPost: true }) route (parse body as
     *   urlencoded, not JSON). Default false = JSON.
     * @returns ExpressWrapper instance
     */
    createExpressWrapper(
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        clientMethod: (requestDto: unknown) => Promise<unknown>,
        path: string,
        formPost: boolean = false,
    ): ExpressWrapper {
        return new ExpressWrapper(clientMethod, path, this.headers, formPost);
    }
}
