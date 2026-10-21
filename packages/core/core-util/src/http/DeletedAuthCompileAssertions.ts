import * as CoreUtil from '../index';

/** Each removed spelling has its own assertion so one missing export cannot mask a shim. */
export class DeletedAuthCompileAssertions {
    removedExports(): void {
        // @ts-expect-error use WpAuth([jwt()]) and WpAuthorization
        void CoreUtil.WpAuthJwt;
        // @ts-expect-error use WpAuth([oidcSameProject()]) or WpAuth([oidcSvcs([...])]) and WpAuthorization
        void CoreUtil.WpAuthOidc;
        // @ts-expect-error oidc(...) is removed: oidcSameProject() for this GCP project, oidcSvcs([...]) for named service accounts
        void CoreUtil.oidc;
        // @ts-expect-error use WpAuth([sharedSecret(...)]) and WpAuthorization
        void CoreUtil.WpAuthSharedSecret;
        // @ts-expect-error use WpAuth([vendorAuth(...)]) and WpAuthorization
        void CoreUtil.WpAuthWebhook;
        // @ts-expect-error webhook(name) is renamed vendorAuth(name): a VendorAuthMinter sends it, a VendorAuthVerifier receives it
        void CoreUtil.webhook;
        // @ts-expect-error EXTERNAL is split: EXTERNAL_INBOUND (an outside system calls us) or EXTERNAL_OUTBOUND (we call it)
        void CoreUtil.EXTERNAL;
        // @ts-expect-error renamed assertExternalEndpointKinds, which also checks EXTERNAL_OUTBOUND contracts
        void CoreUtil.assertEveryExternalEndpointDeclaresCaller;
        // @ts-expect-error renamed assertEveryVendorAuthEndpointRetainsRawBody
        void CoreUtil.assertEveryWebhookEndpointRetainsRawBody;
        // @ts-expect-error use WpAuth([apiKey(...)]) and WpAuthorization
        void CoreUtil.WpAuthApiKey;
        // @ts-expect-error use separate WpLocalOnly, authentication and authorization
        void CoreUtil.WpAuthLocalOnly;
        // @ts-expect-error MCP shares receiving endpoint WpAuthorization
        void CoreUtil.WpMcpAuthJwt;
        // @ts-expect-error unresolved credentials are read with getAuthMeta
        void CoreUtil.getAuthMode;
        // @ts-expect-error roles belong to common operation authorization
        void CoreUtil.rolesRequired;
    }
}
