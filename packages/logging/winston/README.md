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
import { ServiceInfo } from '@webpieces/core-util';
import { WinstonGcpFactory, WinstonConsoleFactory } from '@webpieces/winston';

// FIRST: identify this service. Both factories read name+version in their CONSTRUCTOR, so this
// must come before you build one — a forgotten call throws at startup rather than shipping logs
// that cannot say which build emitted them.
ServiceInfo.setInfo('my-service', '2.1.0');

const loggerFactory = process.env.K_SERVICE
    ? new WinstonGcpFactory()
    : new WinstonConsoleFactory();

// Typically you pass loggerFactory to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...)),
// which calls HeaderRegistry.configure(...) then LogManager.setFactory(loggerFactory) for you.
```

Both factories read the magic context **directly** from `RequestContext` on each line, so
nothing is threaded in: there is no `ContextReader` constructor argument.

## Options

There are none — both factories take no arguments.

- **Service name + version** — from `ServiceInfo.setInfo(...)` (see above), NOT factory options.
  Every line carries `svcName` and `version`. They live in `@webpieces/core-util` because they
  are facts about the SERVICE, not about winston: the bunyan backend reads the same values, and
  `requestIdSource` reads the name (it records which service minted a request-id).
- **`version` is opaque** — a git SHA, a semver tag, a CI build number, whatever identifies your
  build. webpieces neither parses nor derives it; your app decides where it comes from.
- **Local rendering** — neither `svcName` nor `version` renders in `WinstonConsoleFactory` output.
  They earn their keep in GCP (filtering across many services and deploys); locally each service
  logs to its own place and you can check git yourself, so on every line they are just noise.
- **Level** — there is deliberately no knob. webpieces does not filter by level; winston filters
  at its own default.
