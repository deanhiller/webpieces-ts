# Cloud Run OIDC: the edge is the security boundary

`@WpAuthOidc()` describes a service-to-service credential contract. In the intended
private Cloud Run deployment, Google authenticates the invocation and enforces
`roles/run.invoker` before the request reaches the container. The annotation primarily
tells the RPC and Cloud Tasks clients to supply the correct Google ID token; the
server-side Webpieces check is supplementary validation.

## One contract, three responsibilities

1. **Client:** `OutboundAuthFilter` asks `GcpOidc.mintIdToken` for an ID token whose
   audience is the final destination base URL, then sends it as `Authorization: Bearer`.
   Cloud Tasks uses the delivery service account and audience in its OIDC task settings.
2. **Cloud Run edge:** with the invoker IAM check enabled, Google checks the invocation
   token and whether its principal may invoke the service. IAM is the source of truth
   for the ordinary service-level caller allow-list; it belongs in deployment configuration.
3. **Application:** `AuthFilter` invokes the bound `OidcHook`, or `DefaultOidcVerifier`
   when no hook is bound. The default calls `GcpOidc.verifyFromCallers`. An empty caller
   list delegates caller authorization to the edge. Explicit callers add an application
   allow-list. For real Google tokens, the current verifier checks signature/expiry through
   `google-auth-library`, but does not supply an audience constraint of its own.

The application verification remains implemented. Removing redundant server verification
would be a separate behavior/design change; this document does not propose or implement it.
Google's verifier uses cached certificates where available, but application verification
can still involve certificate or IAM-policy network reads. It is not guaranteed to be
an entirely local, constant-time check.

## What makes the intended deployment secure

The service requires Cloud Run invocation authentication, the invoker IAM check is enabled,
and IAM grants invocation to the intended principals. Requests reach the container through
that protected edge. Merely setting `K_SERVICE`, using a `run.app` URL, or adding the decorator
does not establish those deployment properties. An unauthenticated/public deployment or
another entry point that bypasses the edge does not inherit this guarantee.

A direct call to `verifyFromCallers` tests the application component. It does not exercise
Cloud Run ingress, so acceptance by that function alone is not evidence that an unauthenticated
request can invoke a correctly protected private Cloud Run service.

The current public-posture check is advisory: it logs a warning once if it detects a public
service, and failure to read the IAM policy does not reject the request. Treat deployment IAM
as the enforcement, rather than treating this diagnostic as the gate.

## Local and in-process development tokens

Off-GCP, `mintIdToken` emits a deterministic `dev-oidc.*` token so local and in-process tests
can exercise the same contract/filter chain without Google credentials. These tokens encode
an email and audience; they are not signed Google credentials.

Currently `extractVerifiedEmail` recognizes that prefix and decodes the email without a
runtime check. Consequently a direct application-verifier call can accept such a token even
with `K_SERVICE` set, if the claimed email passes any configured caller list. A protected Cloud
Run edge will not accept that synthetic token as the invocation credential. This behavior
relies on the deployment boundary above; the default verifier is not a standalone authentication
boundary for arbitrary hosts or public/direct ingress. Local tests do not validate Google token
issuance, audience enforcement, or deployed IAM.

## The edge credential must be identified correctly

Webpieces' normal RPC path sends its ID token in `Authorization`. Google also supports
`X-Serverless-Authorization` for applications using `Authorization` for a separate purpose.
If both headers are present, Google checks **only `X-Serverless-Authorization`** and removes
that token's signature before forwarding it. Edge admission therefore does not prove that a
separate application `Authorization` token belongs to the same principal. Explicit application
caller lists and trusted-context decisions must be evaluated against the credential they
actually consume; do not equate two independently supplied headers.

See Google's [service-to-service authentication guide](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
for invocation IAM, destination audiences, and header handling.

## Source map

- Contract: [`WpAuthOidc`](../../packages/core/core-util/src/http/decorators.ts).
- RPC minting: [`OutboundAuthFilter`](../../packages/http/http-client-node/src/OutboundAuthFilter.ts).
- Task delivery: [`GcpTaskInvoker`](../../packages/cloud/cloudtasks-client/src/GcpTaskInvoker.ts).
- Server dispatch: [`AuthFilter`](../../packages/http/http-routing/src/filters/AuthFilter.ts),
  [`DefaultOidcVerifier`](../../packages/http/http-routing/src/DefaultOidcVerifier.ts).
- Google and synthetic token handling: [`GcpOidc`](../../packages/cloud/gcp-identity/src/oidc.ts).
