# @webpieces/wp-logging

Pluggable logging interface for WebPieces. Works in both the browser
(Angular/React) and Node.js.

## Why

Different projects use different loggers (bunyan, winston, pino, a plain
`console`, a file writer). This package is essentially an **interface** plus a
browser-safe default, so application code logs through one seam and the backend
is chosen once, per app, at startup.

## Usage

```ts
import { LogManager } from '@webpieces/wp-logging';

const log = LogManager.getLogger('MyClass');
log.info('starting up', { port: 8200 });
log.error('call failed', err);
```

By default logs go to a browser-safe `ConsoleLoggerFactory`. To plug in another
backend, install a `LoggerFactory` once at startup (in a `framework:express`
app for node-only backends):

```ts
import { LogManager, LoggerFactory } from '@webpieces/wp-logging';

LogManager.setFactory(new MyBunyanLoggerFactory(/* ... */));
```

## Exports

- `Logger` — interface: `trace/debug/info/warn/error(message, ...args)`
- `LogLevel` — `'trace' | 'debug' | 'info' | 'warn' | 'error'`
- `LoggerFactory` — interface: `getLogger(name): Logger`
- `ConsoleLogger` / `ConsoleLoggerFactory` — browser-safe default
- `LogManager` — static `getLogger(name)` / `setFactory(factory)` holder

## Browser safety

This package has **zero Node imports** (no `async_hooks`, no `fs`). Node-only
backends must be installed by `framework:express` apps, never inside
browser-safe libraries.
