# Logging — the APPLICATION's own logs

**Scope: what a webpieces *application* logs about its own requests.** This file has nothing to do
with the logs the webpieces *tooling* writes about itself (guard decisions, hook invocations, blocked
writes, branch mutations). Those live in `.webpieces/**/logs/` and are documented in
[`docs/tooling-logs.md`](./docs/tooling-logs.md) — that is the file to open when you are looking for
`guard-invocations.log`, `hook-rejection.log` or `branch-mutations.log`.

The two were previously easy to confuse, because this file said only "logging" and named neither
subject.

## Needed active dimensions for accurate debugging

This is a design checklist, not a description of what is implemented today.

* Global try/catch, all calling one hook
* Request context values (clickId, user, etc.) — see
  [`docs/architecture/context-propagation.md`](./docs/architecture/context-propagation.md)
* Interface lines (contracts) with SERVER request/response, for success / fail / other
* Interface lines (contracts) with CLIENT request/response, for success / fail / other
* `server.log` and `browser.log` on the filesystem

The logging ADAPTERS an application plugs in (`@webpieces/winston`, `@webpieces/bunyan`) are separate
packages; they carry their own READMEs.
