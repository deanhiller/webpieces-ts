# @webpieces/http-routing

> Decorator-based routing with auto-wiring for WebPieces

Part of the [WebPieces TypeScript](https://github.com/deanhiller/webpieces-ts) framework.

## Installation

```bash
npm install @webpieces/http-routing
```

## OIDC on private Cloud Run

`@WpAuth([oidc()])` primarily selects client-side Google ID-token generation. With invocation
authentication and invoker IAM enabled, Cloud Run checks the invocation before it reaches
`AuthFilter`; the framework retains supplementary server validation. No callers means delegate
caller authorization to the edge; explicit callers add an application allow-list. Local tokens
exercise the filter chain without proving deployed IAM or Google signature validation.
See [the Cloud Run OIDC security boundary](../../../docs/architecture/cloud-run-oidc.md) for the
current verifier behavior and the assumptions required for that deployment model.

## Documentation

See the main [WebPieces README](https://github.com/deanhiller/webpieces-ts#readme) for complete documentation and examples.

## License

Apache-2.0

Authentication and operation authorization are separate declarations. See [the migration guide](../../../docs/authorization-migration.md) for policies, canonical context, token-free MCP invocation, and validator release ordering.
