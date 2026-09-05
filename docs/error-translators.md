# Application error translation

Register one `ErrorTranslators` object per process. The server and all node HTTP clients share that registration; register the same class at browser startup. Both directions use `HttpResponseDto`, containing a `{ code, reason }` status, a list of `{ name, value }` headers, and an application-defined body. Express and fetch own the HTTP version, so it is omitted from the DTO.

```typescript
import {
    ClientRegistry, ErrorTranslators, HttpHeader, HttpResponseDto, HttpResponseStatus,
    WEBPIECES_DEFAULT_ERROR_TRANSLATORS,
} from '@webpieces/core-util';

export class OrderNotFoundError extends Error {}
export class OrderErrorBody {
    constructor(public readonly orderId: string) {}
}

export class OrderErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto | undefined {
        if (!(error instanceof OrderNotFoundError)) return undefined;
        return new HttpResponseDto(
            new HttpResponseStatus(460, 'Order Not Found'),
            [new HttpHeader('Retry-After', '30')],
            new OrderErrorBody(error.message),
        );
    }

    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) return undefined;
        const body = response.body;
        if (body === null || typeof body !== 'object' || !('orderId' in body)) return undefined;
        return new OrderNotFoundError(String(body.orderId));
    }
}

ClientRegistry.setErrorTranslators(new OrderErrorTranslators());
```

The server throws `OrderNotFoundError` and either client catches `OrderNotFoundError`. Returning `undefined` uses the webpieces default. To wrap its response or delegate explicitly, call `WEBPIECES_DEFAULT_ERROR_TRANSLATORS.toWire(error)` or `.fromWire(response)`. The default preserves the built-in typed errors and safe messages; only `HttpUserError` publishes its original message.

Headers can repeat, including two `Set-Cookie` entries. Fetch exposes only what its environment permits: real browsers hide `Set-Cookie`, restrict cross-origin headers unless CORS exposes them, and may have an empty reason phrase under HTTP/2. The DTO preserves everything fetch exposes; it cannot restore metadata the browser hides. Ordinary repeated fetch headers may already be combined by fetch. Node fetch's `getSetCookie()` preserves individual cookie values.

The server JSON-serializes the body by default. A string with a non-JSON `Content-Type` is sent as text. The client parses declared JSON and preserves other bodies as text before invoking the application translator. A malformed declared JSON response remains a parse error.

The framework adds `x-request-id` to successful and error responses whenever the request context contains an ID, including application-translated errors. The infrastructure ID takes precedence if an application supplies that same header. Applications can send additional trace headers.

Request path, method and inbound headers are available to `toWire` even when body parsing fails. **Known limitation:** malformed and oversized bodies fail before header transfer and ID generation, so these errors have no framework transaction ID. Unknown routes/404 routing misses remain outside application translation. Cloud Tasks enqueuing has no service response to translate.

## Breaking migration

`addErrorTranslation`, `ErrorTranslation`, and `ErrorWireForm` have been removed. Use `setErrorTranslators`, `ErrorTranslators`, and `HttpResponseDto`. The example company's `CompanySetupOptions.errorTranslators` takes one optional object.

A second `setErrorTranslators` call replaces both directions. If company and application layers previously registered separate translations, compose them explicitly in one object:

```typescript
ClientRegistry.setErrorTranslators({
    toWire: (error: Error) => app.toWire(error) ?? company.toWire(error),
    fromWire: (response: HttpResponseDto) => app.fromWire(response) ?? company.fromWire(response),
});
```

Choose the precedence in application code and register once.
