# @webpieces/webpieces-tooling

Install the complete toolchain through this umbrella package. Its workspace dependencies carry every published tooling package and its public bins, including `wp-ai-rules-hook` and `wp-ai-guards-hook`.

For a published release, declare `@webpieces/webpieces-tooling` as the single tooling dependency. Existing consumers should replace their former Nx umbrella declaration with this package when adopting the release. Keep registering `@webpieces/nx-webpieces-rules` in `nx.json`; that package implements the inference plugin and executors.

OpenClaw uses `@webpieces/webpieces-tooling/openclaw-plugin` and the packaged `openclaw.plugin.json`. Its single write/edit handler composes source rules, workflow guards, and source extensions in their original order.

This package owns packaging and composition smoke checks. Feature suites remain in ai-hook-rules, agent-workflow-rules, pr-gate, and the Nx implementation package.

The repository itself is validated with its previously published catalog release. Adding this source package does not upgrade that installed toolchain or its committed dispatcher.

The ordinary test target runs the small aggregation and OpenClaw checks. Run `pnpm nx run webpieces-tooling:release-test` when changing `scripts/publish-packages.sh`; it exercises the release retry loop in a fake registry workspace and is kept separate from source-rule edit workloads.
