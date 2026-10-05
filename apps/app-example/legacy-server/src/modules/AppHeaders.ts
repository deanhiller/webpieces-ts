import { ContextKey, AnyContextKey } from '@webpieces/core-util';

/**
 * App-specific headers for the legacy server (third tier of the three-tier header
 * system, after framework core + company headers). An instance class (not statics)
 * so it obeys no-function-outside-class — construct one and read getAllHeaders().
 */
export class AppHeaders {
    readonly CLIENT_TYPE = ContextKey.untrusted<string>('clientType', 'x-client-type');

    getAllHeaders(): AnyContextKey[] {
        return [this.CLIENT_TYPE];
    }
}
