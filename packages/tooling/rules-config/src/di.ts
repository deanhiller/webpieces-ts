import 'reflect-metadata';

/**
 * LOCAL copy of the `@DocumentDesign` DI marker decorator.
 *
 * WHY here and not imported from `@webpieces/core-context` / `@webpieces/core-util`:
 * `@webpieces/rules-config` is the FOUNDATION package — nearly everything in the monorepo (including
 * browser + platform packages) depends on it — so it must NEVER depend UP on the platform packages.
 * `core-util` is browser-based and `core-context` is the server-side DI seam; both are the correct
 * home for this decorator for the APPS, but rules-config depending on them would invert the layering.
 *
 * This is byte-for-byte the same decorator (identical behavior + the same
 * `'webpieces:document-design'` metadata key), so the DI-graph analyzer — which matches
 * `@DocumentDesign` by decorator NAME, not import source — recognizes it exactly the same.
 */

// Metadata key for the @DocumentDesign marker (must match core-util's so the analyzer + any reader agree).
export const DESIGN_METADATA_KEYS = {
    DOCUMENT_DESIGN: 'webpieces:document-design',
};

/**
 * @DocumentDesign decorator — marks a class as a DI-design ROOT (the top-of-DAG class the design-doc
 * generator walks). A pure marker read STATICALLY by the DI-graph analyzer by decorator name.
 */
// webpieces-disable no-function-outside-class -- a decorator factory cannot be a class method
export function DocumentDesign(): ClassDecorator {
    return (target: object) => {
        Reflect.defineMetadata(DESIGN_METADATA_KEYS.DOCUMENT_DESIGN, true, target);
    };
}

/** True when a class is marked `@DocumentDesign`. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader; not an injectable service
export function isDocumentDesign(designClass: object): boolean {
    return Reflect.getMetadata(DESIGN_METADATA_KEYS.DOCUMENT_DESIGN, designClass) === true;
}
