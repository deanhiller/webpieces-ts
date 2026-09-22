# Typed HTTP contracts

One decorated API class is the source of truth for all four Webpieces transports: incoming HTTP,
the in-process feature client, the Node HTTP client, and the browser HTTP client. The method's
decorators now describe its HTTP verb, URL parameters, request body, response ownership, and auth
mode. Every transport reads the same metadata and uses the same argument mapper.

## GET, path, and query parameters

Every endpoint names `GET` or `POST` explicitly; there is no method default. Name every path/query
parameter explicitly so a TypeScript variable rename can never change the public wire contract:

```typescript
import {
    ApiPath,
    Endpoint,
    PathParam,
    QueryParam,
    GET,
    POST,
    READ,
    WRITE,
    RPC,
    Rpc,
    WpAuthPublic,
} from '@webpieces/core-util';

@Rpc()
@ApiPath('/catalog')
abstract class CatalogApi {
    @WpAuthPublic('Public catalog lookup')
    @Endpoint(GET, '/owners/{owner}/items/{item}', READ, RPC)
    find(
        @PathParam('owner') owner: string,
        @PathParam('item') item: number,
        @QueryParam('include_archived') includeArchived?: boolean,
        @QueryParam('tag') tags?: string[],
    ): Promise<ItemResult> {
        throw new Error('contract only');
    }
}
```

The generated request is bodyless. Values are URL encoded, `undefined`/`null` query values are
omitted, and arrays repeat the key:

```text
GET /catalog/owners/A%2FB/items/42?include_archived=false&tag=red&tag=blue
```

Incoming values are converted from strings using emitted TypeScript design metadata. `string`,
`number`, `boolean`, and repeated array parameters are supported. Missing path values, invalid
numbers/booleans, or a repeated scalar are a `400 ApiBadRequestError`. A missing query value is
passed as `undefined`; controllers own any domain-level required-field validation.

A `GET` contract must map every method parameter with `@PathParam` or `@QueryParam`, and every
`{placeholder}` must have exactly one matching path parameter. These are startup/client-creation
errors, rather than malformed requests discovered in production.

## POST bodies and forms

A `POST` method may have one unannotated parameter: that parameter is the request body. Path and
query parameters can sit beside it:

```typescript
@WpAuthJwt({ allRolesAllowed: true })
@Endpoint(POST, '/owners/{owner}/items', WRITE, RPC)
create(
    @PathParam('owner') owner: string,
    request: CreateItemRequest,
    @QueryParam('dry_run') dryRun?: boolean,
): Promise<CreateItemResponse> {
    throw new Error('contract only');
}
```

JSON is the default body encoding. For flat `application/x-www-form-urlencoded` protocols, use
the existing `formPost` option:

```typescript
@WpAuthPublic('OAuth token exchange validates the code and PKCE verifier in its payload')
@Endpoint(POST, '/token', WRITE, RPC, { formPost: true, responseType: 'full' })
token(request: TokenRequest): Promise<HttpResponseDto<TokenResponse | OAuthError>> {
    throw new Error('contract only');
}
```

The Node and browser clients serialize form fields symmetrically with the server parser. Nullish
fields are omitted and arrays are repeated. Form DTOs remain flat; nested values belong in JSON.
`formPost` and `rawBody` are POST-only.

## Owning the complete response

Most methods return the decoded successful response body. Set `responseType: 'full'` when protocol
code needs the status, repeated headers, or an intentionally empty body:

```typescript
@WpAuthPublic('OAuth authorization request validates its protocol inputs')
@Endpoint(GET, '/authorize', READ, RPC, { responseType: 'full' })
authorize(
    @QueryParam('client_id') clientId: string,
): Promise<HttpResponseDto<undefined>> {
    throw new Error('contract only');
}

class OAuthController extends OAuthApi {
    override authorize(clientId: string): Promise<HttpResponseDto<undefined>> {
        return Promise.resolve(new HttpResponseDto(
            new HttpResponseStatus(302, 'Found'),
            [new HttpHeader('location', `/consent?client_id=${encodeURIComponent(clientId)}`)],
            undefined,
        ));
    }
}
```

Full-response methods preserve `200`, `201`, `302`, protocol `4xx` responses, empty bodies, and
repeated response headers such as `Set-Cookie`. Redirects use fetch's manual redirect mode so the
client, rather than fetch, owns redirect policy. Browser fetch may expose a cross-origin manual
redirect as an opaque response under the browser's CORS rules; use an allowed same-origin flow or a
server-side client when the redirect status/location must be inspected.

Do not return `HttpResponseDto` from a normal body-only method. Conversely, a full-response server
method must return one. Both mistakes fail loudly at the transport boundary.

## Request context and authentication

All incoming contract routes—GET, JSON POST, and form POST—are registered through the ordinary
Webpieces route/filter boundary. `ContextFilter`, auth filters, logging, recording, and application
filters therefore run before the controller with an active `RequestContext`. A controller can make
a nested generated Node client call without manually creating a new context.

The existing auth vocabulary applies identically to every verb and encoding:

- `@WpAuthPublic` skips the application's JWT requirement, but does **not** promise anonymous
  success. The endpoint must still validate its protocol credentials and payload. OAuth login,
  authorization, registration, and token endpoints commonly use this shape.
- `@WpAuthJwt`, `@WpAuthOidc`, `@WpAuthSharedSecret`, `@WpAuthWebhook`, `@WpAuthApiKey`, and
  `@WpAuthLocalOnly` retain their existing filter behavior.

No special OAuth auth decorator is needed. OAuth client credentials, authorization codes, PKCE
verifiers, redirect URIs, and similar protocol inputs are request data; the controller validates
them after `@WpAuthPublic` admits the request to the endpoint.

The in-process feature client traverses the same mapper, filter chain, and controller invocation as
incoming HTTP. Call it inside `RequestContext.run(...)` with the desired `HttpRequest`/headers when
the endpoint or nested clients require ambient request context.

## Migrating OAuth-shaped routes

Keep one contract and replace hand-written Express URL/body parsing with explicit metadata:

| Protocol route | Contract shape |
| --- | --- |
| discovery/metadata | `GET`, `@WpAuthPublic`, body response |
| dynamic registration | JSON `POST`, `@WpAuthPublic`, often `responseType: 'full'` for `201` and headers |
| authorization | `GET` plus named `@QueryParam`s, `@WpAuthPublic`, full response for redirects/errors |
| token exchange | `POST` plus `formPost: true`, `@WpAuthPublic`, full response for OAuth error payloads |
| authenticated resource | `GET` or `POST` plus the existing applicable `@WpAuthJwt`/`@WpAuthOidc` mode |

This framework capability does not migrate an application's OAuth endpoints automatically. Move
each application route deliberately, preserving its protocol validation and security policy.

## Java reference and deliberate differences

The model follows Java Webpieces' generated client at
`cloud/generate-httpclient/src/main/java/org/webpieces/microsvc/client/impl/HttpsJsonClientInvokeHandler.java`:
select an explicit HTTP method, join class/method paths, replace encoded placeholders, honor
explicit query wire names, omit nulls, and require ambient context for a server-side client.

The TypeScript implementation additionally uses one mapper for both sides and correctly emits all
values in a list as repeated query keys; it does not port Java's last-value-wins list behavior.

Supported generated methods are currently `GET` and `POST`. MCP `POST` with SSE streaming remains a
separate concern: a streaming response is not represented by `HttpResponseDto` and is intentionally
outside this contract feature.
