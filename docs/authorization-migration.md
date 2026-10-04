# Authentication and authorization migration (#1134)

Authentication declares accepted credentials. Authorization declares who may execute the operation.

```ts
@Endpoint(POST, '/read', READ, RPC)
@WpAuth([jwt(), sharedSecret('INTERNAL_API_SECRET')])
@WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
read(request: ReadRequest): Promise<ReadResponse> { /* implementation */ }
```

The credential list is OR. Clients choose one supported mechanism before constructing trusted headers and keep that selection for responses, retries, redirects, streams, and task delivery. Public access uses `@WpAuthPublic('reason')` with `ANONYMOUS` authorization. `@WpLocalOnly()` adds a locality restriction separately.

Replace the standalone credential decorators with descriptors inside `WpAuth`. Replace JWT role requirements with `ALL_USERS` or `ROLES`; application restrictions belong under typed `CUSTOM.appPolicy`. Bind `AUTHORIZATION_HOOK` to an `AuthorizationHook<TPolicy>` that validates the payload at registration and evaluates the entire application decision asynchronously. Standard policy branches never call that hook. Organization and tenant rules remain application policy. A surface-dependent policy reads the trusted `SURFACE` fact in the same hook.

Verified user results publish canonical `USER_ID` and `USER_ROLES` automatically. Roles are encoded as a JSON string array, including `[]` for a verified user with no roles. Conflicting canonical entries are rejected. An external machine authenticator returns `AuthenticatedMachineIdentity` without fabricating a user. `SERVICE_ONLY` requires current-hop machine verification; a delegated user or an LLM surface alone does not satisfy it. API keys and webhooks do not license trusted-header delegation.

MCP keeps access-token verification, issuer/resource/scope/lifetime checks and fresh account validation. Remove endpoint JWT mint configuration and `WpMcpAuthJwt`. Supply the same `AuthorizationService` used by the receiving router:

```ts
config.setAuthorizationService(router.getContainer().get(AuthorizationService));
```

Local MCP bindings pass an explicit token-free invocation proof through the ordinary filter chain. That proof is bound to the actual endpoint and active verified ingress scope. Capturing or restoring context cannot reuse it. A local MCP server does not need a GUI `JWT_HOOK`.

Generated documents are private catalogs. A protected documentation endpoint calls `AuthorizedApiDocument.project` inside the authenticated request, using canonical receiving-route metadata and the same policy service. Serve its result to the caller and derive operation lookup/search/navigation from that projection. Hidden operations and exclusively reachable component definitions are removed; shared transitive definitions remain. Pass a bundled catalog, not one containing external schema references. Do not mount the complete private catalog at another public URL or cache one user's projection for another user.

## Framework repository release ordering

This repository builds source while its installed webpieces tooling normally comes from the previous release. Source changes to declarations must update every affected validator, extractor, fixture and runtime consumer in the same release. A validator from the installed release can still reject the new source spelling even after its source implementation is fixed.

For that interval, temporarily exempt the feature branch with `turnOffRuleWhileOnBranch` in the rule-pack owner file referenced by `webpieces.config.json`. Keep the rule's enforcement mode. Test the updated validator directly from source; passing the previous validator's old tests does not validate the new declaration.

The next repository upgrade must install the webpieces release containing these changes, update the version catalog and lockfile, remove the temporary exemptions, run `pnpm wp-rules-sync`, and run the enabled rules against the migrated contracts. The upgrade and re-enablement are one operation. Do not reinstall the previous release and call that completion, or retain permanent rule disables to mask incompatible tooling. Apply this sequence whenever source declarations and the installed validators differ across a release.
