# @webpieces/winston

Node-only [winston](https://github.com/winstonjs/winston) backends for the webpieces
pluggable logging seam (`LoggerFactory` → `Logger` from `@webpieces/core-util`).

Two factories, both auto-enriching every line with the logged context keys registered in
`HeaderRegistry`:

- **`WinstonConsoleFactory`** — local dev: colorized single-line pretty output,
  `[loggerName] [requestId=… tenantId=…] level: message {…extra}`.
- **`WinstonGcpFactory`** — Cloud Run / GKE: flat JSON to **stdout**, scraped by the logging
  agent. A level→`severity` map is the only GCP glue (no `@google-cloud` transport);
  registered context keys land at top-level `jsonPayload.<name>`. This mirrors the
  tested-in-GCP logger in `onetablet/monorepo-nx1`.

## Usage

```ts
import { LogManager, HeaderRegistry } from '@webpieces/core-util';
import { WinstonGcpFactory, WinstonConsoleFactory } from '@webpieces/winston';
import { RequestContextReader } from '@webpieces/core-context';

const reader = new RequestContextReader();
const loggerFactory = process.env.K_SERVICE
    ? new WinstonGcpFactory(reader)
    : new WinstonConsoleFactory(reader);

// Typically you pass loggerFactory to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...)),
// which calls HeaderRegistry.configure(...) then LogManager.setFactory(loggerFactory) for you.
```

The `ContextReader` is a **constructor argument** (the node `RequestContextReader` lives in
`@webpieces/core-context`) so this package depends only on `@webpieces/core-util` — not on
any node context package.

## Options

`new WinstonGcpFactory(reader, new WinstonFactoryOptions(level, svcGitHash))`:

- `level` — minimum webpieces level to emit (default `'info'`). `trace` maps to winston `silly`.
- `svcGitHash` — when set, every line carries `jsonPayload.svcGitHash` (deployment filter).
