import { VendorAuthVerifier } from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import * as ClientNode from './index';
import { OutboundAuthFilter } from './OutboundAuthFilter';

/**
 * COMPILE-TIME proof that the deleted outbound auth spellings stay deleted. The outbound half of
 * `webhook(name)` (#1339) and the unified `VendorAuthHook` that replaced it (#1358) are both gone:
 * this client mints with the OUTBOUND role `VendorAuthMinter` (core-context) and nothing else. Each
 * `@ts-expect-error` fails the build (TS2578) the moment its symbol is exported or accepted again. A
 * compiled file, never a `.spec.ts`, because vitest strips types and a spec's `@ts-expect-error` is
 * inert.
 */
export class DeletedAuthCompileAssertions {
    removedExports(): void {
        // @ts-expect-error WebhookSignerCallback is replaced by VendorAuthMinter.mint (bind VENDOR_AUTH_MINTER)
        void ClientNode.WebhookSignerCallback;
        // @ts-expect-error WEBHOOK_SIGNER_CALLBACK is replaced by VENDOR_AUTH_MINTER
        void ClientNode.WEBHOOK_SIGNER_CALLBACK;
        // @ts-expect-error MissingWebhookSignerError is replaced by MissingClientCredentialError (thrown by createRpcClient)
        void ClientNode.MissingWebhookSignerError;
        // @ts-expect-error VendorAuthHook is DELETED: the client binds the OUTBOUND role VendorAuthMinter
        void ClientNode.VendorAuthHook;
        // @ts-expect-error VENDOR_AUTH_HOOK is DELETED: bind VENDOR_AUTH_MINTER
        void ClientNode.VENDOR_AUTH_HOOK;
        // @ts-expect-error MissingVendorAuthHookError is replaced by MissingClientCredentialError (thrown by createRpcClient)
        void ClientNode.MissingVendorAuthHookError;
        // @ts-expect-error MissingVendorAuthMinterError is DELETED (#1362): createRpcClient throws MissingClientCredentialError instead of the first call
        void ClientNode.MissingVendorAuthMinterError;
        // @ts-expect-error MissingSharedSecretError is DELETED (#1362): createRpcClient throws MissingClientCredentialError instead of the first call
        void ClientNode.MissingSharedSecretError;
        // @ts-expect-error the INBOUND role is the server's (http-routing); a client package never exports it
        void ClientNode.VENDOR_AUTH_VERIFIER;
    }

    /**
     * The outbound filter takes the OUTBOUND role only. Handing it the server's inbound verifier —
     * the shape that put the verifier into every RPC proxy's construction (#1358) — must not compile.
     */
    outboundFilterRefusesTheVerifier(oidc: GcpOidc, verifier: VendorAuthVerifier): void {
        // @ts-expect-error a VendorAuthVerifier cannot mint: OutboundAuthFilter takes a VendorAuthMinter
        void new OutboundAuthFilter(oidc, undefined, verifier);
    }
}
