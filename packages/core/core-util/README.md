# @webpieces/core-util

Utility functions for WebPieces applications. Works in both browser and Node.js environments.

## Portable API errors and IPC

React Native consumers use `@webpieces/core-util/errors` for canonical semantic errors (`ApiEndUserError`, `ApiNotFoundError`, and the other API categories) and `@webpieces/core-util/ipc` for shared contracts and connection types. These two subpaths are checked with public declaration fixtures, Metro Android/iOS bundles, and Hermes compilation; the broad root barrel is not certified for React Native.

Use `@webpieces/ipc-bridge` for generated clients and typed receivers. HTTP preserves status 266 for `ApiEndUserError`: monitoring succeeds, while generated clients throw it for GUI display. Its optional `edgeHttpStatus` (400/404/409/422, the third constructor argument before `cause`) survives every hop and is what a partner-facing edge in `setEndUserStatus('edge')` mode answers instead. All API errors are transport-neutral, use standard `cause`, and have no HTTP `.code`. See [the taxonomy and verification guide](https://github.com/deanhiller/webpieces-ts/blob/main/docs/portable-ipc-and-errors.md).

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

`@WpStream(() => RequestEvent, () => ResponseEvent)` marks one API method with the shared duplex
contract. The server receives request events through the returned `RequestStream`; callers receive
response events through the `ResponseStream` passed to the method. The same declaration drives the
HTTP server, Node and browser clients, and in-process feature client.

Every `event`, `fail`, and `complete` call awaits its next transport/consumer boundary. Events are
therefore ordered and backpressured rather than accumulated in an unbounded framework buffer.
`complete` and terminal `fail` permanently close that direction, writes after termination reject, and
`cancel` runs registered cancellation work once. Failures are terminal by default. A non-terminal
failure continues only on an adapter that explicitly supports it; otherwise it is promoted to
terminal. `StreamCorrelation` is an explicit stable application key and never relies on object
identity or event arrival order.

The generic HTTP request direction uses NDJSON: each `StreamEnvelope` is one JSON record followed by
`\n`. The response direction uses SSE: `event: message`, one or more `data:` lines, then a blank line.
Blank lines (`\n\n` or `\r\n\r\n`) dispatch an event, multiple `data:` lines join with `\n`, and a
leading `:` is a comment/keepalive. Generic SSE does not use `id` or `Last-Event-ID` for resumption.
Open failures use the ordinary typed Webpieces HTTP error/status mapping. Legal in-band failures carry
the standard `ApiErrorPayload`; disconnects, malformed frames, and failures that cannot be written are
reported locally as `StreamTransportError` with their cause and available correlation metadata.

## Related Packages

- [@webpieces/nx-webpieces-rules](https://www.npmjs.com/package/@webpieces/nx-webpieces-rules) - Includes ESLint rule that enforces this pattern
- [@webpieces/core-context](https://www.npmjs.com/package/@webpieces/core-context) - Request context management
- [@webpieces/http-server](https://www.npmjs.com/package/@webpieces/http-server) - HTTP server

## License

Apache-2.0
