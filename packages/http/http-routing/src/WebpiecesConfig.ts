/**
 * Configuration for WebPieces server.
 * Per CLAUDE.md: Data-only structure = class
 */
export class WebpiecesConfig {
    /**
     * EXTRA cross-origin origins to allow, beyond the two that are always allowed: the server's OWN
     * origin (same-origin — a browser sends `Origin` on every POST, even same-origin, so this is what
     * lets a server that also serves its own UI answer its own api calls) and `localhost:*` (dev).
     *
     * Only needed when the browser origin differs from the api origin AND is not localhost — e.g. a
     * UI on a CDN/custom domain calling an api on a different host. Exact origin match, e.g.
     * `['https://app.example.com']`.
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
