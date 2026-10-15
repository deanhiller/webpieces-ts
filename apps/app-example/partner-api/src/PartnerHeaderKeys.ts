import { ContextKey } from '@webpieces/core-util';

/**
 * The headers of the `partner` api-key regime, each defined ONCE as a {@link ContextKey} (#1249).
 *
 * Every surface names the KEY, never the header string: the contract's `apiKey(...)` credentials,
 * the server's ApiKeyHook reading the pair, and the published OpenAPI document — which `wp-openapi`
 * builds by following `PartnerHeaderKeys.API_KEY` to the factory call below and reading its
 * `httpHeader`. A rename here therefore moves every one of them together.
 *
 * Both are UNTRUSTED: each is merely asserted by the partner until the hook validates the pair.
 */
export class PartnerHeaderKeys {
    /** The partner's key. Masked in logs — it is a credential. */
    static readonly API_KEY = ContextKey.untrusted<string>('partnerApiKey', 'x-api-key', true);

    /** The organization the key is acting for, validated together with the key by the hook. */
    static readonly ORGANIZATION_ID = ContextKey.untrusted<string>(
        'partnerOrganizationId',
        'x-organization-id',
    );
}
