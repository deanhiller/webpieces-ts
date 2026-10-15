import { WebpiecesCoreHeaders } from '@webpieces/core-util';

/**
 * The response headers this service stamps on every reply, named by their `ContextKey`.
 *
 * `openapi.manifest.json` names this exported KEY in `contextKey`, never a header string, and
 * `wp-openapi` reads the header name off the key's own `ContextKey.untrusted(...)` definition — its
 * `responseHeader`, which is exactly what the server's response choke point writes. JSON cannot
 * import, so a literal in the manifest would be a copy a rename leaves silently stale (#1249).
 */
export const REQUEST_ID_KEY = WebpiecesCoreHeaders.REQUEST_ID;
