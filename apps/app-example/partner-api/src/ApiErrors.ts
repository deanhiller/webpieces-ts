/**
 * The DOCUMENT-WIDE failure body.
 *
 * `openapi.manifest.json` names this TYPE and `wp-openapi` reads its shape with the compiler, so the
 * published error schema is the one on the wire rather than a hand-written copy of it. That is the
 * whole reason the manifest names a type instead of carrying a schema: a schema in JSON is a second
 * declaration, and nothing could contradict it.
 */
export interface ApiErrorResponse {
    /** A stable, machine-readable code. Branch on this, never on `message`. */
    code: string;

    /** What went wrong, for a human reading a log. Wording is not part of the contract. */
    message: string;

    /** Field name -> what is wrong with it. Present on validation failures only. */
    details?: Record<string, string>;
}
