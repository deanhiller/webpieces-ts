# Responsibilities — gcp-identity

GCP runtime identity for Node services: project/region/service-account metadata, Cloud Run URL derivation, and OIDC token mint/verify — with deterministic localhost/dev fallbacks off-GCP so tests and local dev need no GCP.

## In Scope

- Metadata reads: project id, numeric project id, region, service name (`K_SERVICE`), runtime service-account email
- Cloud Run URL derivation (`getSelfCloudRunUrl`, `getCloudRunUrl`)
- OIDC mint/verify (`mintIdToken`, `verifyOidcFromCallers`), including `dev-oidc.*` tokens off-GCP
- `isOnGcp()` detection with localhost/dev fallbacks for every value

## Out of Scope

- HTTP routing, filters, Express/server concerns
- Cloud Tasks enqueue/transport logic (that is cloudtasks-client)
- Knowledge of API contracts or decorators

## Notes

- Node-only (google-auth-library / gcp-metadata); not browser-safe.
