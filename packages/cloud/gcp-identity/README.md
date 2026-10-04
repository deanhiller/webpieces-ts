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
- `GcpOidc.verifyFromCallers(idToken, callers)` — verify + allow-list the caller SA

Underpins the `oidc(...)` service-to-service credential contract used by
`@webpieces/http-client-node` (RPC) and `@webpieces/cloudtasks-client`, with supplementary
server checks dispatched by `AuthFilter`.

## Private Cloud Run: Google enforces invocation access

The protected Cloud Run edge verifies the invocation ID token and enforces `roles/run.invoker`
before the container receives it. The annotation primarily tells clients to generate the
correct destination-audience token. A bare `@WpAuth([oidc()])` delegates caller authorization to
that edge; explicit callers add an application allow-list. Real tokens are also checked by the
application verifier, without its own audience constraint.

Synthetic `dev-oidc.*` tokens support local/in-process tests and are unsigned. The current
application decoder accepts that prefix without checking the runtime; the protected Cloud Run
edge rejects it as an invocation credential. A direct verifier call does not test ingress IAM,
and this verifier must not be treated as standalone protection for public/direct ingress.
See [the Cloud Run OIDC guide](../../../docs/architecture/cloud-run-oidc.md) for deployment
assumptions, the advisory public-posture check, and separate-header handling.

**There is exactly ONE service name.** The Cloud Run service name is what you report, what peers
call you by, and what goes in every URL — yours and theirs. Nothing strips or adds a prefix: deploy
a service as `tf-server2` and its `svcName` is `tf-server2`. (`getServiceName()` used to strip a
leading `tf-`, which made that service unreachable by the very name it reported.)

**URL resolution itself does not live here** — it lives in `ClientRegistry`
(`@webpieces/core-util`, browser-safe), which runs one chain for every client: a registered mapping,
else the installed deriver, else the caller's fallback. This package only supplies the GCP deriver.
That is the seam: an AWS deployment installs `templateDeriver` (or just registers mappings) and
never pulls `gcp-metadata` onto the URL path.
