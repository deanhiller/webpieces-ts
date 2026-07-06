import 'reflect-metadata';

/**
 * Metadata keys for server-side routing.
 * These are specific to the routing package (server-side only).
 */
export const ROUTING_METADATA_KEYS = {
    DOCUMENT_DESIGN: 'webpieces:document-design',
    SOURCE_FILEPATH: 'webpieces:source-filepath',
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
        Reflect.defineMetadata(ROUTING_METADATA_KEYS.DOCUMENT_DESIGN, true, target);
    };
}

/**
 * Helper function to check if a class is marked as a DI-design root.
 * Server/library side only.
 */
export function isDocumentDesign(designClass: object): boolean {
    return Reflect.getMetadata(ROUTING_METADATA_KEYS.DOCUMENT_DESIGN, designClass) === true;
}

/**
 * SourceFile decorator to explicitly set the source filepath for a controller.
 * This is used by filter matching to determine which filters apply to the controller.
 *
 * If not specified, the system will use a heuristic based on the controller's name.
 *
 * Usage:
 * @SourceFile('src/controllers/admin/UserController.ts')
 * @DocumentDesign()
 * export class UserController { ... }
 *
 * @param filepath - The source filepath of the controller
 */
export function SourceFile(filepath: string): ClassDecorator {
    return (target: any) => {
        Reflect.defineMetadata(ROUTING_METADATA_KEYS.SOURCE_FILEPATH, filepath, target);
    };
}

// NOTE: provideSingleton / provideSingletonAs / provideTransient moved to
// @webpieces/core-context (the shared DI seam). http-routing re-exports them
// from there in index.ts for back-compat.
