# @webpieces/core-util

Utility functions for WebPieces applications. Works in both browser and Node.js environments.

## Portable API errors and IPC

React Native consumers use `@webpieces/core-util/errors` for canonical semantic errors (`UserError`, `NotFoundError`, and the other API categories) and `@webpieces/core-util/ipc` for shared contracts and connection types. These two subpaths are checked with public declaration fixtures, Metro Android/iOS bundles, and Hermes compilation; the broad root barrel is not certified for React Native.

Use `@webpieces/ipc-bridge` for generated clients and typed receivers. HTTP preserves status 266 for `UserError`: monitoring succeeds, while generated clients throw it for GUI display. Old Http-prefixed names are deprecated aliases; neutral errors use standard `cause` and have no HTTP `.code`. See [the migration and verification guide](https://github.com/deanhiller/webpieces-ts/blob/main/docs/portable-ipc-and-errors.md).

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

## Related Packages

- [@webpieces/nx-webpieces-rules](https://www.npmjs.com/package/@webpieces/nx-webpieces-rules) - Includes ESLint rule that enforces this pattern
- [@webpieces/core-context](https://www.npmjs.com/package/@webpieces/core-context) - Request context management
- [@webpieces/http-server](https://www.npmjs.com/package/@webpieces/http-server) - HTTP server

## License

Apache-2.0
