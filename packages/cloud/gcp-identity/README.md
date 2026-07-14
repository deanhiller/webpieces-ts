# @webpieces/gcp-identity

GCP runtime identity for webpieces services (Node-only). Everything is read from the
GCP metadata server / ADC at runtime — nothing is configured. Off-GCP (local dev,
tests) every call falls back to a deterministic localhost value so no GCP is needed.

- `getProjectId()` / `getNumericProjectId()` / `getRegion()` — cached metadata lookups
- `getServiceName()` — this service's name from `K_SERVICE`, verbatim, else `'local'`
- `getSelfCloudRunUrl()` — this service's own base URL
- `gcpCloudRunDeriver()` — the GCP half of URL resolution: `svcName` → `https://<svc>-<projectNumber>.<region>.run.app`. Install it once at startup with `ClientRegistry.setDeriver(gcpCloudRunDeriver())` and every same-project/same-region peer resolves with no URL table. Off GCP (a CLI, CI) pass the values instead: `gcpCloudRunDeriver(new GcpCloudRunTarget(projectNumber, region))`
- `getRuntimeServiceAccountEmail()` — the SA this process runs as
- `mintIdToken(audience)` — Google-signed OIDC ID token (a `dev-oidc.*` token off-GCP)
- `verifyOidcFromCallers(idToken, callers)` — verify + allow-list the caller SA

Underpins the `@AuthOidc` service-to-service auth mode enforced by `ServiceAuthFilter`
and used by `@webpieces/http-client` (RPC) and `@webpieces/cloudtasks-client`.

**There is exactly ONE service name.** The Cloud Run service name is what you report, what peers
call you by, and what goes in every URL — yours and theirs. Nothing strips or adds a prefix: deploy
a service as `tf-server2` and its `svcName` is `tf-server2`. (`getServiceName()` used to strip a
leading `tf-`, which made that service unreachable by the very name it reported.)

**URL resolution itself does not live here** — it lives in `ClientRegistry`
(`@webpieces/core-util`, browser-safe), which runs one chain for every client: a registered mapping,
else the installed deriver, else the caller's fallback. This package only supplies the GCP deriver.
That is the seam: an AWS deployment installs `templateDeriver` (or just registers mappings) and
never pulls `gcp-metadata` onto the URL path.
