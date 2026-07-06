# @webpieces/gcp-identity

GCP runtime identity for webpieces services (Node-only). Everything is read from the
GCP metadata server / ADC at runtime — nothing is configured. Off-GCP (local dev,
tests) every call falls back to a deterministic localhost value so no GCP is needed.

- `getProjectId()` / `getNumericProjectId()` / `getRegion()` — cached metadata lookups
- `getServiceName()` — logical name from `K_SERVICE` (strips a `tf-` prefix), else `'local'`
- `getSelfCloudRunUrl()` / `getCloudRunUrl(name)` — deterministic Cloud Run URLs
- `getRuntimeServiceAccountEmail()` — the SA this process runs as
- `mintIdToken(audience)` — Google-signed OIDC ID token (a `dev-oidc.*` token off-GCP)
- `verifyOidcFromCallers(idToken, callers)` — verify + allow-list the caller SA

Underpins the `@AuthOidc` service-to-service auth mode enforced by `ServiceAuthFilter`
and used by `@webpieces/http-client` (RPC) and `@webpieces/cloudtasks-client`.
