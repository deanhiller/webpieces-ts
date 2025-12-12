/**
 * Configuration for WebPieces server.
 * Per CLAUDE.md: Data-only structure = class
 */
export class WebpiecesConfig {
    // Empty for now - placeholder for future config options
    // CORS is auto-enabled for localhost:* → localhost:*
}

/**
 * DI token for WebpiecesConfig injection.
 */
export const WEBPIECES_CONFIG_TOKEN = Symbol.for('WebpiecesConfig');
