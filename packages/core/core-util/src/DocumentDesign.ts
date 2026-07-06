import 'reflect-metadata';

/**
 * Metadata key for the @DocumentDesign marker.
 *
 * Lives in core-util (browser + Node) rather than a server-only package because
 * @DocumentDesign marks design roots for ANY project kind — server controllers AND
 * library implementation classes — none of which are express/server specific.
 */
export const DESIGN_METADATA_KEYS = {
    DOCUMENT_DESIGN: 'webpieces:document-design',
};

/**
 * @DocumentDesign decorator — marks a class as a DI-design ROOT: the top-of-DAG class whose
 * dependency-injection tree the design-doc generator walks and renders into that project's
 * `design.json` / `design.md` / `design.html`.
 *
 * It is the single marker for every kind of design root — server controllers (the class an
 * `ApiRoutingFactory(Api, Controller)` binds) and library implementation classes (the top class a
 * `role:designed-lib` project exports and binds in its `ContainerModule`). A `role:designed-lib`
 * project is REQUIRED to have at least one `@DocumentDesign` class — otherwise the DI-graph
 * generator has no root and fails.
 *
 * This is a pure marker read STATICALLY by the DI-graph analyzer (by decorator name); nothing reads
 * its runtime metadata. Routing does NOT depend on it — routes are wired explicitly by
 * `ApiRoutingFactory(Api, Controller)`, which reads `@ApiPath`/`@Endpoint` off the API class and
 * `@SourceFile` off the controller. The metadata below exists only for symmetry/debuggability.
 *
 * Usage:
 * ```typescript
 * @DocumentDesign()
 * @injectable()
 * export class SaveController extends SaveApi { ... }
 * ```
 */
export function DocumentDesign(): ClassDecorator {
    return (target: object) => {
        Reflect.defineMetadata(DESIGN_METADATA_KEYS.DOCUMENT_DESIGN, true, target);
    };
}

/**
 * Helper function to check if a class is marked as a DI-design root.
 */
export function isDocumentDesign(designClass: object): boolean {
    return Reflect.getMetadata(DESIGN_METADATA_KEYS.DOCUMENT_DESIGN, designClass) === true;
}
