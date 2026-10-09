# @webpieces/core-util

Utility functions for WebPieces applications. Works in both browser and Node.js environments.

## Portable API errors and IPC

React Native consumers use `@webpieces/core-util/errors` for canonical semantic errors (`ApiEndUserError`, `ApiNotFoundError`, and the other API categories) and `@webpieces/core-util/ipc` for shared contracts and connection types. These two subpaths are checked with public declaration fixtures, Metro Android/iOS bundles, and Hermes compilation; the broad root barrel is not certified for React Native.

Use `@webpieces/ipc-bridge` for generated clients and typed receivers. HTTP preserves status 266 for `ApiEndUserError`: monitoring succeeds, while generated clients throw it for GUI display. Its optional `edgeHttpStatus` (400/404/409/422, the third constructor argument before `cause`) survives every hop and is what a server answers instead when the CALLER's `SURFACE` is `public-api` (see `SurfaceEndUserStatus`). All API errors are transport-neutral, use standard `cause`, and have no HTTP `.code`. See [the taxonomy and verification guide](https://github.com/deanhiller/webpieces-ts/blob/main/docs/portable-ipc-and-errors.md).

## Installation

```bash
npm install @webpieces/core-util
```

## Features

### toError() - Standardized Error Handling

The `toError()` function converts any thrown value into a proper Error instance.

#### Usage

```typescript
import { toError } from '@webpieces/core-util';

try {
  await riskyOperation();
} catch (err: unknown) {
  const error = toError(err);
  console.error('Operation failed:', error.message);
  throw error;
}
```

#### Why use toError()?

JavaScript allows throwing any value, not just Errors:
- `throw "string error"` - loses stack trace
- `throw { code: 404 }` - not an Error instance
- `throw null` - extremely unhelpful

`toError()` ensures you always have a proper Error object with:
- Type safety (always returns Error)
- Stack traces preserved when available
- Consistent error structure
- Integration with logging/monitoring

#### Enforced Pattern

WebPieces projects enforce this pattern via ESLint rule `@webpieces/catch-error-pattern`:

**Required:**
```typescript
try {
  operation();
} catch (err: unknown) {
  const error = toError(err);
  // Handle error...
}
```

**Alternative (explicitly ignored errors):**
```typescript
try {
  operation();
} catch (err: unknown) {
  //const error = toError(err);
}
```

#### Nested Catch Blocks

For nested catches, use numbered suffixes:

```typescript
try {
  operation1();
} catch (err: unknown) {
  const error = toError(err);
  try {
    rollback();
  } catch (err2: unknown) {
    const error2 = toError(err2);
    console.error('Rollback failed:', error2);
  }
}
```

#### Behavior

| Input Type | Behavior | Example |
|------------|----------|---------|
| Error instance | Returned unchanged | `toError(new Error('msg'))` → same Error |
| Error-like object | Converts to Error, preserves message/name/stack | `toError({message: 'msg', stack: '...'})` |
| Object without message | Stringifies object | `toError({code: 404})` → `Error("Non-Error object thrown: {...}")` |
| String | Wraps in Error | `toError("error")` → `Error("error")` |
| Number | Converts to string | `toError(404)` → `Error("404")` |
| null/undefined | Generic message | `toError(null)` → `Error("Null or undefined thrown")` |

## Browser Compatibility

This package has zero dependencies and works in all modern browsers and Node.js environments.

## Typed streaming contracts

`@WpStream(StreamDirection.RESPONSE | REQUEST | FULL)` makes the direction part of the shared API
contract. The method signature is the only declaration of the initial request/response and later
event types; generated schema wiring registers the four derived schemas separately from the
decorator.

`RESPONSE` is the browser-safe shape:

```ts
@WpStream(StreamDirection.RESPONSE)
abstract watch(
    request: WatchRequest,
    responses: ResponseStream<WatchEvent>,
): Promise<WatchAccepted>;
```

The finite request body contains the initial request and closes. The promise resolves after the
initial response has arrived and validated; later response records are delivered incrementally.
Browser clients reject `REQUEST` and `FULL` at bind time because Fetch cannot consume a response
while keeping a streaming upload open.

Every `event` and `close` call awaits its next transport/consumer boundary. Events are ordered and
backpressured. `close()` ends only that direction; `cancel(error?)` terminates the whole exchange
and delivers cancellation to the peer once. There are no non-terminal failures, `fail`, `complete`,
or `onCancel` methods. Business correlation belongs in the application's own DTO.

`FULL` returns `Promise<RequestStream<InitialResponse, RequestEvent>>` and accepts a
`ResponseStream<ResponseEvent>` second parameter. `REQUEST` returns the same request-stream shape
but has no response-stream parameter. Install the build-generated `stream-Contract-schemas.json`
using `registerStreamingCatalog(Contract, catalog)` before binding a contract; `wp-openapi` derives
all required schema slots from these signatures and diagnoses mismatched forms.

The HTTP media type is `application/x-webpieces-jsonl`. Initial values and ordinary events are raw
application-owned JSON records followed by `\n`; Webpieces never wraps them in a `kind` or `payload`
object. An abnormal post-open cancellation is the reserved sideband record
`0x1E + {"control":"error","response":<HttpResponseDto>} + \n`. This reuses the configured
`ErrorTranslator` in both directions without making an error look like an application event.
Graceful `close()` remains ordinary directional EOF. Transport loss where no control record can cross
is reported locally as `StreamTransportError`.

## Related Packages

- [@webpieces/nx-webpieces-rules](https://www.npmjs.com/package/@webpieces/nx-webpieces-rules) - Includes ESLint rule that enforces this pattern
- [@webpieces/core-context](https://www.npmjs.com/package/@webpieces/core-context) - Request context management
- [@webpieces/http-server](https://www.npmjs.com/package/@webpieces/http-server) - HTTP server

## License

Apache-2.0

### MCP profile membership

`Mcp.DEFAULT` is the reserved base tool group. `@WpMcpTool(name, title)` and an omitted
`profiles` option select only that group. `{ profiles: ['admin'] }` selects only admin;
`{ profiles: [Mcp.DEFAULT, 'admin'] }` explicitly shares a tool between both groups. Membership is
independent of `@WpAuthorization` roles and never grants account permissions. Identifiers match
`[a-z][a-z0-9-]{0,63}`; empty lists, duplicates and malformed options are rejected.
See `@webpieces/mcp-server` for independent endpoint/resource configuration and union selection.
