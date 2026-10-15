# Cloud Run OIDC: the edge, then the caller scope

`@WpAuth([oidcSameProject()])` and `@WpAuth([oidcSvcs([...])])` describe a service-to-service
credential contract. In the intended private Cloud Run deployment, Google authenticates the
invocation and enforces `roles/run.invoker` before the request reaches the container. The
descriptor tells the RPC and Cloud Tasks clients to supply the correct Google ID token, and it
names which callers the application itself accepts:

- `oidcSameProject()`: any service account of the callee's own GCP project. Most endpoints want this.
- `oidcSvcs([...])`: exactly the listed service accounts, which may belong to other projects.

An endpoint may pair one of each, for example
`@WpAuth([oidcSameProject(), oidcSvcs(['partner-sa@other-project.iam.gserviceaccount.com']), jwt()])`.
Both are the one `oidc` bearer credential: the client mints one token, the token's signature is
verified once, and the call passes when either scope admits the caller.

## One contract, three responsibilities

1. **Client:** `OutboundAuthFilter` asks `GcpOidc.mintIdToken` for an ID token whose
   audience is the final destination base URL, then sends it as `Authorization: Bearer`.
   Cloud Tasks uses the delivery service account and audience in its OIDC task settings.
2. **Cloud Run edge:** with the invoker IAM check enabled, Google checks the invocation
   token and whether its principal may invoke the service. IAM is the source of truth
   for the ordinary service-level caller allow-list; it belongs in deployment configuration.
3. **Application:** `AuthFilter` passes ALL of the endpoint's OIDC methods (`OidcAuthMethods`) to the
   bound `OidcHook`, or to `DefaultOidcVerifier` when no hook is bound, which calls `GcpOidc.verify`.
   It verifies the token once and admits the call when any method admits the caller. For
   `oidcSameProject()` the token's email must be a user-managed service account of this
   project (`<name>@<projectId>.iam.gserviceaccount.com`) or the project's Compute Engine default
   (`<projectNumber>-compute@developer.gserviceaccount.com`). Google service agents live under
   Google-owned domains and are refused, like accounts of other projects and user accounts. For
   `oidcSvcs([...])` the email must be one of the listed accounts: `'self'` is this service's runtime
   account, a bare id is an account of this project, and a full email is taken verbatim. For real
   Google tokens the verifier checks signature/expiry through `google-auth-library`, but does not
   supply an audience constraint of its own.

The project id and project number come from the metadata server. Google's verifier uses cached
certificates where available, but application verification can still involve certificate or
metadata network reads. It is not guaranteed to be an entirely local, constant-time check.

## What makes the intended deployment secure

The service requires Cloud Run invocation authentication, the invoker IAM check is enabled,
and IAM grants invocation to the intended principals. Requests reach the container through
that protected edge. Merely setting `K_SERVICE`, using a `run.app` URL, or adding the decorator
does not establish those deployment properties. An unauthenticated/public deployment or
another entry point that bypasses the edge does not inherit this guarantee.

The application check does not replace invoker IAM. On a private service it narrows WHO again
after the edge; on a public service, or behind any entry point that bypasses the edge, it is the
only caller check, which is why it has to see the deployment correctly (next section). There is no
public-posture warning any more: it existed for an OIDC endpoint that named no callers and trusted
the edge to choose them, and no OIDC descriptor does that now.

A direct call to `GcpOidc.verify` tests the application component. It does not exercise Cloud Run
ingress, so acceptance by that function alone is not evidence that an
unauthenticated request can invoke a correctly protected private Cloud Run service.

## Off GCP, and local and in-process development tokens

Off GCP there is no project to compare against, so `oidcSameProject()` is open: any token that
verifies is accepted. `oidcSvcs([...])` still enforces its list.

Off-GCP, `mintIdToken` emits a deterministic `dev-oidc.*` token so local and in-process tests
can exercise the same contract/filter chain without Google credentials. These tokens encode
an email and audience; they are not signed Google credentials.

Mint and verify agree on where such a token is legitimate. `GcpOidc.verify` accepts the prefix
only when `isOnGcp()` is false, the same condition under which `mintIdToken` creates one. When
`isOnGcp()` is true (`K_SERVICE` is set, or `METADATA_SERVER_DETECTION=assume-present`), a synthetic
token is refused and logged as a warning before any project or caller check, so neither
`oidcSameProject()` nor an `oidcSvcs([...])` list naming the email it claims admits it. A protected
Cloud Run edge also rejects that synthetic token as the invocation credential.

Both rules follow `isOnGcp()`, which reads those two environment variables. A deployed host that
sets neither, for example GCE or GKE without `METADATA_SERVER_DETECTION=assume-present`, is treated
as off GCP: it accepts synthetic tokens, and `oidcSameProject()` admits a Google-signed caller of
any project. Set the variable on such hosts. The default verifier is still not a standalone
authentication boundary for arbitrary hosts or public/direct ingress. Local tests do not validate
Google token issuance, audience enforcement, or deployed IAM.

## The edge credential must be identified correctly

Webpieces' normal RPC path sends its ID token in `Authorization`. Google also supports
`X-Serverless-Authorization` for applications using `Authorization` for a separate purpose.
If both headers are present, Google checks **only `X-Serverless-Authorization`** and removes
that token's signature before forwarding it. Edge admission therefore does not prove that a
separate application `Authorization` token belongs to the same principal. Application caller
checks and trusted-context decisions must be evaluated against the credential they actually
consume; do not equate two independently supplied headers.

See Google's [service-to-service authentication guide](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
for invocation IAM, destination audiences, and header handling.

## Source map

- Contract: [`oidcSameProject` / `oidcSvcs`](../../packages/core/core-util/src/http/auth-mode.ts).
- RPC minting: [`OutboundAuthFilter`](../../packages/http/http-client-node/src/OutboundAuthFilter.ts).
- Task delivery: [`GcpTaskInvoker`](../../packages/cloud/cloudtasks-client/src/GcpTaskInvoker.ts).
- Server dispatch: [`AuthFilter`](../../packages/http/http-routing/src/filters/AuthFilter.ts),
  [`DefaultOidcVerifier`](../../packages/http/http-routing/src/DefaultOidcVerifier.ts).
- Google and synthetic token handling: [`GcpOidc`](../../packages/cloud/gcp-identity/src/oidc.ts).
