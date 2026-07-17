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
import { ServiceInfo } from '@webpieces/core-util';
import { BunyanGcpFactory, BunyanConsoleFactory } from '@webpieces/bunyan';

// FIRST: identify this service. Both factories read name+version in their CONSTRUCTOR, so this
// must come before you build one — a forgotten call throws at startup rather than shipping logs
// that cannot say which build emitted them.
ServiceInfo.setInfo('my-service', '2.1.0');

const loggerFactory = process.env.K_SERVICE
    ? new BunyanGcpFactory()
    : new BunyanConsoleFactory();

// Typically you pass loggerFactory to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...)),
// which calls HeaderRegistry.configure(...) then LogManager.setFactory(loggerFactory) for you.
```

Both factories read the magic context **directly** from `RequestContext` on each line, so
nothing is threaded in: there is no `ContextReader` constructor argument.

`BunyanGcpFactory` sends to the Cloud Logging API and needs GCP Application Default
Credentials on the instance (automatic on Cloud Run), exactly as the source service runs.

## Options

There are none — both factories take no arguments.

- **Service name + version** — from `ServiceInfo.setInfo(...)` (see above), NOT factory options.
  The name becomes bunyan's mandatory root-logger `name` and surfaces as `name` in the payload;
  the version rides as a bunyan base field and surfaces as `version`. They live in
  `@webpieces/core-util` because they are facts about the SERVICE, not about bunyan: the winston
  backend reads the same values, and `requestIdSource` reads the name (it records which service
  minted a request-id).
- **`version` is opaque** — a git SHA, a semver tag, a CI build number, whatever identifies your
  build. webpieces neither parses nor derives it; your app decides where it comes from.
- **Level** — there is deliberately no knob. webpieces does not filter by level; bunyan
  filters at its own default.
