/**
 * Configuration for WebPieces server.
 * Per CLAUDE.md: Data-only structure = class
 */
export class WebpiecesConfig {
    /**
     * The browser origins allowed to call this api CROSS-ORIGIN. Empty/unset (the default) means
     * CORS middleware is NEVER MOUNTED — leave it that way in production.
     *
     * You almost never want this in production. A server that also serves its own browser app does
     * NOT need cors: a browser applies no cors check to a same-origin request. Turning cors on grants
     * every origin listed here the right to make CREDENTIALED cross-origin calls and READ the
     * responses, so an unnecessary entry here is pure attack surface.
     *
     * Set it in exactly two cases, where the browser really is on a different origin than the api:
     * 1. LOCAL DEV — `ng serve` on :4200 calling an api on :8080. Use the wildcard port, because the
     *    dev-server port moves: `config.corsOrigins = ['http://localhost:*'];`
     * 2. A UI HOSTED ON A DIFFERENT HOST than the api (CDN / custom domain):
     *    `config.corsOrigins = ['https://app.example.com'];`
     *
     * Matching is EXACT, with one exception: a `*` in the PORT position matches any port
     * (`http://localhost:*`). It is not a general wildcard — it never spans a host, so
     * `http://localhost:*` will not match `http://localhost.evil.com`, and a bare `*` matches
     * nothing. The server's OWN origin is always allowed when cors is mounted (a browser sends
     * `Origin` on every POST, even a same-origin one, so the middleware would otherwise 403 the
     * server's own UI).
     */
    corsOrigins?: string[];

    /**
     * Record EVERY request as a test case (fixture + generated spec), instead
     * of only requests carrying the x-webpieces-recording header.
     * Intended for tests/dev - do not leave on in production.
     */
    recordingAlwaysOn?: boolean;

    /**
     * Directory where recorded fixtures + generated specs are written.
     * When unset, recordings are only logged.
     */
    recordingDir?: string;
}

/**
 * DI token for WebpiecesConfig injection.
 */
export const WEBPIECES_CONFIG_TOKEN = Symbol.for('WebpiecesConfig');
