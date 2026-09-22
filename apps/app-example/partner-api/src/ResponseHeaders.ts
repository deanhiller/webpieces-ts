/**
 * The response headers this service stamps on every reply.
 *
 * `openapi.manifest.json` names the CONSTANT, not the header, and `wp-openapi` folds it. JSON cannot
 * import, so a literal in the manifest would be a copy that a rename here leaves silently stale —
 * and the published document would then document a header nothing sets, with both files internally
 * consistent and no test able to tell.
 */
export const REQUEST_ID_HEADER = 'x-request-id';
