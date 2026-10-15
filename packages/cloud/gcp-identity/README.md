# @webpieces/gcp-identity

GCP runtime identity for webpieces services (Node-only). Everything is read from the
GCP metadata server / ADC at runtime — nothing is configured. Off-GCP (local dev,
tests) every call falls back to a deterministic localhost value so no GCP is needed.

- `getProjectId()` / `getNumericProjectId()` / `getRegion()` — cached metadata lookups
- `getServiceName()` — this service's name from `K_SERVICE`, verbatim, else `'local'`
- `getSelfCloudRunUrl()` — this service's own base URL
- `gcpCloudRunDeriver()` — the GCP half of URL resolution: `svcName` → `https://<svc>-<projectNumber>.<region>.run.app`. Install it once at startup with `ClientRegistry.setDeriver(gcpCloudRunDeriver())` and every same-project/same-region peer resolves with no URL table. Off GCP (a CLI, CI) pass the values instead: `gcpCloudRunDeriver(new GcpCloudRunTarget(projectNumber, region))`
- `getRuntimeServiceAccountEmail()` — the SA this process runs as
- `GcpOidc.mintIdToken(audience)` — Google-signed OIDC ID token (a `dev-oidc.*` token off-GCP)
- `GcpOidc.verify(idToken, methods)` — verify the token ONCE against the endpoint's OIDC methods (`oidcSameProject()` and/or `oidcSvcs([...])`); the call passes when any of them admits the caller

Underpins the `oidcSameProject()` / `oidcSvcs([...])` service-to-service credential contract used by
`@webpieces/http-client-node` (RPC) and `@webpieces/cloudtasks-client`, with the server checks
dispatched by `AuthFilter`.

## Private Cloud Run: Google enforces invocation access, the application checks the caller

The protected Cloud Run edge verifies the invocation ID token and enforces `roles/run.invoker`
before the container receives it. The descriptor tells clients to generate the correct
destination-audience token and names the callers the application accepts:

- `oidcSameProject()` admits a Google-signed token from a user-managed service account of this
  project (`<name>@<projectId>.iam.gserviceaccount.com`) or from the project's Compute Engine
  default (`<projectNumber>-compute@developer.gserviceaccount.com`). Google service agents, other
  projects and user accounts are refused. Off GCP there is no project, so the check is open.
- `oidcSvcs([...])` admits exactly the listed accounts: `'self'` is this service's runtime
  account, a bare id is an account of this project, and a full email is taken verbatim, so an
  account of another project can be listed.

Real tokens are checked for signature and expiry, without an audience constraint of the verifier's own.

Synthetic `dev-oidc.*` tokens support local/in-process tests and are unsigned. `verify` accepts
that prefix only off GCP, where `mintIdToken` creates it: when `isOnGcp()` is true it refuses
one (`ok:false`, logged as a warning) before any project or caller check. The protected Cloud Run
edge also rejects it as an invocation credential. `isOnGcp()` reads `K_SERVICE` /
`METADATA_SERVER_DETECTION`, so a deployed host that sets neither is treated as off GCP: it still
accepts a synthetic token, and the `oidcSameProject()` check is open there. Set
`METADATA_SERVER_DETECTION=assume-present` on such hosts. A direct verifier call does not test
ingress IAM, and this verifier must not be treated as standalone protection for public/direct ingress.
See [the Cloud Run OIDC guide](../../../docs/architecture/cloud-run-oidc.md) for deployment
assumptions and separate-header handling.

**There is exactly ONE service name.** The Cloud Run service name is what you report, what peers
call you by, and what goes in every URL — yours and theirs. Nothing strips or adds a prefix: deploy
a service as `tf-server2` and its `svcName` is `tf-server2`. (`getServiceName()` used to strip a
leading `tf-`, which made that service unreachable by the very name it reported.)

**URL resolution itself does not live here** — it lives in `ClientRegistry`
(`@webpieces/core-util`, browser-safe), which runs one chain for every client: a registered mapping,
else the installed deriver, else the caller's fallback. This package only supplies the GCP deriver.
That is the seam: an AWS deployment installs `templateDeriver` (or just registers mappings) and
never pulls `gcp-metadata` onto the URL path.
