import 'reflect-metadata';
import { provide } from '@inversifyjs/binding-decorators';
import type { BindInWhenOnFluentSyntax } from 'inversify';

/**
 * LOCAL copies of the `@provideSingleton` and `@DocumentDesign` DI decorators.
 *
 * WHY here and not imported from `@webpieces/core-context` / `@webpieces/core-util`:
 * `@webpieces/rules-config` is the FOUNDATION package — nearly everything in the monorepo (including
 * browser + platform packages) depends on it — so it must NEVER depend UP on the platform packages.
 * `core-util` is browser-based and `core-context` is the server-side DI seam; both are the correct
 * home for these decorators for the APPS, but rules-config depending on them would invert the layering.
 *
 * These are byte-for-byte the same decorators (identical behavior + the same
 * `'webpieces:document-design'` metadata key and the same `@inversifyjs/binding-decorators` provider
 * registry), so the DI-graph analyzer — which matches `@DocumentDesign` / `@provideSingleton` by
 * decorator NAME, not import source — recognizes them exactly the same, and a consumer's
 * `buildProviderModule()` still auto-includes rules-config's `@provideSingleton` classes.
 */

// Metadata key for the @DocumentDesign marker (must match core-util's so the analyzer + any reader agree).
export const DESIGN_METADATA_KEYS = {
    DOCUMENT_DESIGN: 'webpieces:document-design',
};

/**
 * Provides a singleton-scoped dependency. When called without arguments, the class binds to itself.
 */
// webpieces-disable no-function-outside-class -- a decorator factory cannot be a class method
export function provideSingleton(): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        return provide(target, (bind: BindInWhenOnFluentSyntax<unknown>) => bind.inSingletonScope())(target);
    };
}

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
