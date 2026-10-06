# Responsibilities — browser-storage-api

Example browser vendor contract: the abstract `BrowserStorageApi` seam (key/value storage) that `angular-site` binds to a vendor implementation with `Binder.bindExternal`, recording a `uses / external` runtime edge.

## In Scope

- The abstract `BrowserStorageApi` contract — an external seam with no `@ApiPath`

## Out of Scope

- Any implementation of the seam → the consuming app (`angular-site`'s `LoggedLocalStorage`)
- HTTP API contracts → `client-server-api`, `server2-api`

## Notes (optional)

Contract-only library, mirroring a consumer's `libraries/apis/external-rn-browser/**` api-lib: the implementation lives in the app, so the contract references no browser global and no framework.
