import 'reflect-metadata';

/**
 * Metadata keys for server-side routing.
 * These are specific to the routing package (server-side only).
 *
 * NOTE: @DocumentDesign (and its DOCUMENT_DESIGN metadata key) moved to
 * @webpieces/core-util — it is a design-root marker for ANY project kind
 * (browser + Node), not server-only. http-routing re-exports it in index.ts
 * for back-compat.
 */
export const ROUTING_METADATA_KEYS = {
    SOURCE_FILEPATH: 'webpieces:source-filepath',
};

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

// NOTE: provideSingleton / provideSingletonDefaultForApi / provideTransient moved to
// @webpieces/core-context (the shared DI seam). http-routing re-exports them
// from there in index.ts for back-compat.
