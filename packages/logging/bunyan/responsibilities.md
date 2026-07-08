# Responsibilities — bunyan

Node-only bunyan backends for the webpieces logging seam: a `BunyanConsoleFactory` (local
pretty text) and a `BunyanGcpFactory` (Cloud Logging via `@google-cloud/logging-bunyan`),
both `LoggerFactory` impls that enrich every line with the logged `HeaderRegistry` keys.

## In Scope

- `BunyanConsoleFactory` / `BunyanGcpFactory` (`LoggerFactory` impls) + `BunyanLogger`
- bunyan streams: GCP (`@google-cloud/logging-bunyan`) and local console text formatter
- Mapping the 5 webpieces levels onto bunyan levels; merging masked context fields per call;
  normalizing/truncating an `Error` into `err: { name, message, stack }`

## Out of Scope

- Defining context keys / configuring `HeaderRegistry` (the app does that)
- Providing a `ContextReader` implementation — the node `RequestContextReader` lives in
  `@webpieces/core-context` and is passed into the factory constructor
- Choosing cloud-vs-local at runtime (the app picks which factory to install)
- The GCP severity/field mapping itself (owned by `@google-cloud/logging-bunyan`)
- Browser use (bunyan is node-only)

## Notes

- Depends only on `@webpieces/core-util` (plus bunyan + @google-cloud/logging-bunyan).
- `BunyanGcpFactory` sends to the Cloud Logging API and needs GCP ADC on the instance,
  matching the tested `trytami` service.
