import * as ClientNode from './index';

/**
 * COMPILE-TIME proof that the outbound half of `webhook(name)` stays deleted (#1339): ONE
 * `VendorAuthHook` (core-context) now mints, refreshes and verifies. Each `@ts-expect-error` fails
 * the build (TS2578) the moment its symbol is exported again. A compiled file, never a `.spec.ts`,
 * because vitest strips types and a spec's `@ts-expect-error` is inert.
 */
export class DeletedAuthCompileAssertions {
    removedExports(): void {
        // @ts-expect-error WebhookSignerCallback is replaced by VendorAuthHook.mint (bind VENDOR_AUTH_HOOK)
        void ClientNode.WebhookSignerCallback;
        // @ts-expect-error WEBHOOK_SIGNER_CALLBACK is replaced by VENDOR_AUTH_HOOK
        void ClientNode.WEBHOOK_SIGNER_CALLBACK;
        // @ts-expect-error MissingWebhookSignerError is replaced by MissingVendorAuthHookError
        void ClientNode.MissingWebhookSignerError;
    }
}
