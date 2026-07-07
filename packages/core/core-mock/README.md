# @webpieces/core-mock

Typed mock framework for webpieces feature tests — the TypeScript port of Java
webpieces' `core-mock` (`MockSuperclass`).

Where Java requires a hand-written mock subclass per api, `createMock<T>()`
returns a `Proxy` implementing the api with the identical prime/assert
vocabulary:

```typescript
const mockRemote = createMock<RemoteApi>('RemoteApi');

// prime
mockRemote.mock.addValueToReturn('fetchValue', { value: 'primed' });
mockRemote.mock.addExceptionToThrow('fetchValue', () => new Error('boom'));
mockRemote.mock.setDefaultReturnValue('fetchValue', { value: 'default' });

// rebind in the test container
rebind(TYPES.RemoteApi).toConstantValue(mockRemote);

// assert
const requests = mockRemote.mock.getSingleRequestList<FetchValueRequest>('fetchValue');
expect(requests[0].name).toBe('two-hop');
```

Semantics (matching Java `MockSuperclass`):
- Primed values form a queue per method; each call dequeues one.
- Empty queue falls back to the default value; no default → throws
  "test did not add enough return values".
- `getCalledMethodList`/`getSingleRequestList` DRAIN the recorded calls.
