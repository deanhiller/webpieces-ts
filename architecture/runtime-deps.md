# Runtime dependencies (generated — do not edit)

Generated from `runtime-dependencies.json` by `pnpm nx run architecture:generate`; the JSON stays the source for queries.
Covers webpieces services only. Calls to or from non-webpieces services are not shown, so a missing edge
means "not modelled", not "no call"; the outside callees we do know of are under "Not modelled here".
Names are project names, as in `build-deps.md`.

## Service calls

```text
angular-site -rpc-> client-server [PublicApi, SaveApi]
client-server -rpc-> server2 [Server2Api]
legacy-server -rpc-> server2 [Server2Api]
```

## Triggers

```text
-
```

## Not modelled here (outbound calls to remote services, external systems and unresolved APIs)

```text
angular-site -> BrowserStorageApi (owner browser-storage-api)
```

## Services

```text
angular-site [client L3]: -
client-server [server L2]: PublicApi, SaveApi, SecureApi
legacy-server [server L2]: PublicApi, SaveApi
app-example-e2e [server L1]: -
server2 [server L1]: Server2Api
```
