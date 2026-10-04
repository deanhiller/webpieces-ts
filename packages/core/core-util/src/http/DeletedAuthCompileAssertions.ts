import * as CoreUtil from '../index';

/** Each removed spelling has its own assertion so one missing export cannot mask a shim. */
export class DeletedAuthCompileAssertions {
    removedExports(): void {
        // @ts-expect-error use WpAuth([jwt()]) and WpAuthorization
        void CoreUtil.WpAuthJwt;
        // @ts-expect-error use WpAuth([oidc(...)]) and WpAuthorization
        void CoreUtil.WpAuthOidc;
        // @ts-expect-error use WpAuth([sharedSecret(...)]) and WpAuthorization
        void CoreUtil.WpAuthSharedSecret;
        // @ts-expect-error use WpAuth([webhook(...)]) and WpAuthorization
        void CoreUtil.WpAuthWebhook;
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
