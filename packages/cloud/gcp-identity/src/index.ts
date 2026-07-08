/**
 * @webpieces/gcp-identity
 *
 * GCP runtime identity (Node-only). Metadata, Cloud Run URLs, and OIDC mint/verify,
 * all read from the metadata server / ADC at runtime with deterministic localhost
 * fallbacks off-GCP so local dev and tests never touch GCP.
 *
 * Underpins the @AuthOidc service-to-service auth mode (enforced by the framework AuthFilter
 * via an app-bound AuthConfig) and the RPC + Cloud Tasks clients.
 */

export { isOnGcp } from './metadata';
export {
    getServiceName,
    getProjectId,
    getRegion,
    getRuntimeServiceAccountEmail,
    getSelfCloudRunUrl,
    getCloudRunUrl,
    LOCAL_SERVICE_ACCOUNT_EMAIL,
} from './urls';
export { mintIdToken, verifyOidcFromCallers, OidcVerifyResult } from './oidc';
