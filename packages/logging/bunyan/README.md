# @webpieces/bunyan

Node-only [bunyan](https://github.com/trentm/node-bunyan) backends for the webpieces
pluggable logging seam (`LoggerFactory` → `Logger` from `@webpieces/core-util`).

Two factories, both auto-enriching every line with the logged context keys registered in
`HeaderRegistry`:

- **`BunyanConsoleFactory`** — local dev: human-readable, greppable text to stdout,
  `[LEVEL][time][ctx tags]: message` + multi-line error details.
- **`BunyanGcpFactory`** — GCP: streams to Cloud Logging via
  [`@google-cloud/logging-bunyan`](https://github.com/googleapis/nodejs-logging-bunyan),
  which owns the numeric-level→severity mapping and structured payload. Registered context
  keys ride along as payload fields. This mirrors the tested-in-GCP `trytami` service.

## Usage

```ts
import { LogManager, HeaderRegistry } from '@webpieces/core-util';
import { BunyanGcpFactory, BunyanConsoleFactory } from '@webpieces/bunyan';
import { RequestContextReader } from '@webpieces/core-context';

const reader = new RequestContextReader();
const loggerFactory = process.env.K_SERVICE
    ? new BunyanGcpFactory(reader)
    : new BunyanConsoleFactory(reader);

// Typically you pass loggerFactory to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...)),
// which calls HeaderRegistry.configure(...) then LogManager.setFactory(loggerFactory) for you.
```

The `ContextReader` is a **constructor argument** (the node `RequestContextReader` lives in
`@webpieces/core-context`) so this package depends only on `@webpieces/core-util` — not on
any node context package.

`BunyanGcpFactory` sends to the Cloud Logging API and needs GCP Application Default
Credentials on the instance (automatic on Cloud Run), exactly as the source service runs.

## Options

`new BunyanGcpFactory(reader, new BunyanFactoryOptions(level, serviceName))`:

- `level` — minimum webpieces level to emit (default `'info'`).
- `serviceName` — the bunyan logger `name` (default `'webpieces'`), surfaced in the payload.
