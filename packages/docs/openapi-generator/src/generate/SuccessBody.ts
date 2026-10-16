import { TypeRef } from '@webpieces/api-doc-model';

/**
 * Whether an endpoint's success response carries a BODY — asked by the renderer (which documents a
 * body only when there is one) and by {@link MissingReturnsGuard} (which demands `@returns` only when
 * there is one). One answer in one place, so the guard and the published response cannot disagree.
 */
export class SuccessBody {
    /** `Promise<void>` reaches the model as the `unknown` primitive — there is no body to document. */
    isVoid(response: TypeRef | undefined): boolean {
        return (
            response === undefined ||
            (response.kind === 'primitive' && response.primitive === 'unknown')
        );
    }
}
