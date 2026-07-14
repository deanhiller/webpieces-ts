/**
 * @webpieces/gcp-identity
 *
 * GCP runtime identity (Node-only). Metadata, Cloud Run URLs, and OIDC mint/verify,
 * all read from the metadata server / ADC at runtime with deterministic localhost
 * fallbacks off-GCP so local dev and tests never touch GCP.
 *
 * Underpins the @AuthOidc service-to-service auth mode (enforced by the framework AuthFilter
 * via an app-bound AuthConfig) and the RPC + Cloud Tasks clients.
 *
 * URL RESOLUTION lives in core-util's browser-safe `ClientRegistry`, NOT here; this package
 * contributes only the GCP half of it — {@link gcpCloudRunDeriver}, which an app installs with
 * `ClientRegistry.setDeriver(...)` at startup. That is the seam that lets a non-GCP deployment use
 * `templateDeriver` (or plain mappings) and never pull gcp-metadata onto the URL path.
 */

export { isOnGcp, resetMetadataForTests } from './metadata';
export {
    getServiceName,
    getProjectId,
    getRegion,
    getRuntimeServiceAccountEmail,
    getSelfCloudRunUrl,
    LOCAL_SERVICE_ACCOUNT_EMAIL,
} from './urls';
export { gcpCloudRunDeriver, GcpCloudRunTarget } from './gcpCloudRunDeriver';
export { GcpOidc, OidcVerifyResult } from './oidc';
