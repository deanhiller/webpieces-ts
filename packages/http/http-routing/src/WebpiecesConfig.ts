/**
 * Configuration for WebPieces server.
 * Per CLAUDE.md: Data-only structure = class
 */
export class WebpiecesConfig {
    // CORS is auto-enabled for localhost:* → localhost:*

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
