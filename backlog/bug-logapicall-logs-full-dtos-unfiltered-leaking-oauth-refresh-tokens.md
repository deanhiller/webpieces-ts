# BUG: LogApiCall logs full request/response DTOs unfiltered — leaking OAuth refresh tokens into cloud logs

**Package:** `@webpieces/core-util` (`src/http/LogApiCall.ts`)
**Version seen:** `0.4.459`
**Severity:** High — **silent cleartext credential disclosure**, on by default, with no opt-out. A
long-lived Gmail OAuth **refresh token** is currently sitting in Google Cloud Logging in a
production project because of this. The app works perfectly while doing it; nothing warns, and no
log level or config suppresses bodies. Found in `ctoteachings/monorepo` (helper-portal, prod).

## Symptom

`LogApiCallImpl.execute` stringifies the WHOLE request DTO and the WHOLE response with no field
filtering, so any secret riding on a DTO across a logged hop is written to the log in cleartext.

Real production log line (token values truncated for this report — they are NOT truncated in the log):

```
[API-client-resp-SUCCESS] HelperFsdbApi.getEmailAccount response={"account":{
  "id":"Y7ejk...","emailAddress":"user@example.com",
  "refreshToken":"1//04hg2kWy8UcIvCgYIARAAGAQSNwF-L9Irok...",   <-- long-lived Gmail credential
  "accessToken":"ya29.a0ARGnu0Z3kOEMUUz9VxWT7EoSOZU8Rvk...",
  "grantedScopes":["https://www.googleapis.com/auth/gmail.readonly"], ...}}
```

Both sides of every hop log, so a single call emits the secret **twice** — once from the client-side
`[API-client-*]` line and once from the server-side `[API-server-*]` line.

Not Gmail-specific. The same mechanism logs a full Google ID token JWT at login:

```
[API-server-req] AuthApi.loginOauth request={"providerId":"google.com","credential":"eyJhbGciOiJSUzI1NiIs..."}
```

## Root cause

`core-util/src/http/LogApiCall.ts`, in `LogApiCallImpl.execute` (line numbers from the published JS):

```ts
const requestBody  = JSON.stringify(requestDto);   // ~line 75
const requestSize  = this.byteSize(requestBody);
...
log.info(`[API-${side}-req] ${id} request=${requestBody}`);

const responseBody = JSON.stringify(response);     // ~line 88
log.info(`[API-${side}-resp-SUCCESS] ${id} response=${responseBody}`);
```

There is no field filter and no hook to supply one. The DEFAULT is the problem: nothing has to opt
IN to leak. Every new DTO that carries a secret is exposed automatically, and it fails silently.

## Requested fix — a maskable-field filter on the log path

Let the caller declare, per api/method, which fields are sensitive and how to render them:

1. **Partial** — mask but keep the last 4 characters, e.g. `****9f0e`. Enough to correlate two
   tokens across a trace without disclosing either.
2. **Full** — replace entirely, e.g. `*****`.

Suggested shape: carry the spec alongside the existing call metadata (on `ApiMethodInfo`, or as a
new optional param to `LogApiCall.execute`) so it travels with the api definition rather than being
configured globally per app:

```ts
// illustrative only
new ApiMethodInfo('client', CLIENT_NAME, 'getEmailAccount', {
    mask: { refreshToken: 'full', accessToken: 'last4', credential: 'full' },
});
```

**Nested and array DTOs must be covered.** The leak above is at `response.account.refreshToken` —
one level down — so matching must be by field path, or by field name at any depth. A top-level-only
filter would not have caught this.

### `@DoNotRecord` already exists and is most of this mechanism

`core-util/src/http/recorder/DoNotRecord.ts` is a property decorator whose docstring already says it
is for "volatile or **sensitive** fields (timestamps, generated ids, **secrets**)", with the
metadata plumbing and a `getDoNotRecordFields(instance)` reader already written. **Only the fixture
recorder consults it — `LogApiCall` never does.**

So one option is to have `LogApiCall` honour `@DoNotRecord` (plus a new partial/`last4` variant)
and get declaration-at-the-DTO for free, instead of adding a second parallel mechanism. Either
direction is fine — flagging it so the two don't drift apart, and so "which fields are secret" isn't
declared twice in two different ways.

### Trap to document in whatever lands

The masking MUST live in the logging path ONLY. Implementing it as `toJSON()` on the DTO is tempting
and wrong: `JSON.stringify` is also what the RPC transport uses to put the DTO **on the wire**, so a
masking `toJSON()` would send `"*****"` to the real server and break auth at runtime.

## Workarounds available today

None that are good. An app can restructure its apis so secrets never cross a logged hop — e.g. keep
token refresh entirely inside the fsdb data server and never return tokens to the app server. That
is a real architecture change made solely to dodge the logger, and it is not always possible.

## Acceptance check

1. A DTO with a field declared sensitive (`full`) logs `*****` in BOTH the `[API-client-*]` and
   `[API-server-*]` lines, on request and response paths.
2. A field declared `last4` logs `****` + the final 4 characters, and nothing else of the value.
3. A sensitive field nested inside an object and inside an array element is masked.
4. The value sent ON THE WIRE is unchanged — a round-trip through a real client/server pair still
   authenticates. (This is the regression that a `toJSON()` implementation would fail.)
5. A DTO with no mask spec logs exactly as it does today (no behaviour change for existing callers).
