# Responsibilities — gcp-identity

GCP runtime identity for Node services: project/region/service-account metadata, Cloud Run URL derivation, and OIDC token mint/verify — with deterministic localhost/dev fallbacks off-GCP so tests and local dev need no GCP.

## In Scope

- Metadata reads: project id, numeric project id, region, service name (`K_SERVICE`, verbatim — no prefix rules), runtime service-account email
- This service's own URL (`getSelfCloudRunUrl`)
- The GCP `ServiceUrlDeriver` (`gcpCloudRunDeriver`) — the Cloud Run formula, from the metadata server ON GCP or from a supplied `GcpCloudRunTarget` off it
- OIDC mint/verify (`mintIdToken`, `verifyOidcFromCallers`), including `dev-oidc.*` tokens off-GCP
- `isOnGcp()` detection with localhost/dev fallbacks for every value

## Out of Scope

- The URL-resolution CHAIN itself (mapping → deriver → fallback) — that is `ClientRegistry` in core-util, which is browser-safe and knows nothing of GCP. This package only contributes one deriver an app opts into
- HTTP routing, filters, Express/server concerns
- Cloud Tasks enqueue/transport logic (that is cloudtasks-client)
- Knowledge of API contracts or decorators

## Notes

- Node-only (google-auth-library / gcp-metadata); not browser-safe.
