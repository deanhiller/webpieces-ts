# @webpieces/http-client-browser

The browser HTTP client. The client and the server share ONE API contract; calling a method on the
client makes the HTTP request the server's controller answers.

DI-free on purpose — this may be bundled by React or Angular, so it ships no inversify and no
`@webpieces/core-context`. Browsers have no ambient request scope, so the app holds a
`MutableContextStore` and sets values as they become known; every outbound call transfers them.

```ts
HeaderRegistry.configure(AppHeaders.getAllHeaders(), CompanyHeaders.getAllHeaders(), true);

const store = new MutableContextStore();
const factory = new ClientHttpBrowserFactory(store);
const saveApi = factory.createClient(SaveApi, new ClientConfig(env.apiBaseUrl));

const res = await saveApi.save({ query: 'test' });   // type-safe

// later, after login — every subsequent call carries these
store.set(WebpiecesCoreHeaders.AUTHORIZATION, token);
store.set(CompanyHeaders.TENANT_ID, tenantId);
```

A browser cannot hold service credentials, so a contract with an `@AuthOidc` endpoint fails fast at
`createClient`. The server twin is [@webpieces/http-client-node](../http-client-node).
