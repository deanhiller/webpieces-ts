# Build dependencies (generated — do not edit)

Generated from `dependencies.json` by `pnpm nx run architecture:generate`; the JSON stays the source for queries.
One line per project, deepest level first: `<dir> [<role> L<level>]: <deps>` (`-` = none).
A dep is a project name: the last segment of its `<dir>`, unless its line reads `<dir> (<name>)`.
Before adding code to a project, read `<dir>/responsibilities.md` (exceptions are indexed at the end).

```text
apps/app-example/e2e (app-example-e2e) [server L9]: client-server, server2
packages/tooling/webpieces-tooling [bundle L9]: agent-workflow-rules, ai-hook-rules, code-rules, nx-webpieces-rules, pr-gate
apps/app-example/angular-site [client L8]: browser-storage-api, client-server-api, company-core, http-client-browser
apps/app-example/client-server [server L8]: client-server-api, company-svc-core, core-mock, server2-api
apps/app-example/legacy-server [server L8]: client-server-api, company-svc-core, server2-api
apps/app-example/server2 [server L8]: company-svc-core, server2-api
packages/tooling/pr-gate [app L8]: hook-runtime
apps/app-example/company-svc-core [lib L6]: company-core, http-server
packages/http/mcp-server [lib L6]: http-server
packages/http/http-server [lib L5]: http-routing
packages/tooling/agent-workflow-rules [lib L5]: hook-runtime
packages/tooling/ai-hook-rules [lib L5]: hook-runtime
packages/tooling/nx-webpieces-rules [lib L5]: api-doc-model, eslint-rules
packages/http/http-routing [designed-lib L4]: cloudtasks-client, http-client-node
packages/tooling/code-rules [lib L4]: rules-config
packages/tooling/eslint-rules [lib L4]: rules-config
packages/tooling/hook-runtime [lib L4]: rules-config
apps/app-example/partner-api [api-lib L3]: docs-site, openapi-generator
packages/cloud/cloudtasks-client [designed-lib L3]: gcp-identity
packages/http/http-client-node [designed-lib L3]: gcp-identity, http-client-core
packages/tooling/rules-config [designed-lib L3]: repo-workflow-core, rules-sdk
packages/cloud/gcp-identity [lib L2]: core-context
packages/docs/openapi-generator [lib L2]: api-doc-model
packages/http/http-client-browser [designed-lib L2]: http-client-core
packages/logging/bunyan [lib L2]: core-context
packages/logging/winston [lib L2]: core-context
packages/tooling/repo-workflow-core [lib L2]: tooling-common, tooling-testkit
apps/app-example/client-server-api [api-lib L1]: core-util
apps/app-example/company-core [lib L1]: core-util
apps/app-example/server2-api [api-lib L1]: core-util
packages/core/core-context [lib L1]: core-util
packages/core/ipc-bridge [lib L1]: core-util
packages/docs/api-doc-model [lib L1]: core-util
packages/docs/openapi-import [lib L1]: core-util
packages/http/http-client-core [lib L1]: core-util
packages/tooling/tooling-testkit [lib L1]: rules-sdk, tooling-common
apps/app-example/browser-storage-api [api-lib L0]: -
packages/core/core-mock [lib L0]: -
packages/core/core-util [lib L0]: -
packages/docs/docs-site [lib L0]: -
packages/tooling/rules-sdk [lib L0]: -
packages/tooling/tooling-common [lib L0]: -
```
