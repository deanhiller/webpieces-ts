# Responsibilities — winston

Node-only winston backends for the webpieces logging seam: a `WinstonConsoleFactory` (local
pretty) and a `WinstonGcpFactory` (Cloud Run stdout JSON with a level→severity map), both
`LoggerFactory` impls that enrich every line with the logged `HeaderRegistry` context keys.

## In Scope

- `WinstonConsoleFactory` / `WinstonGcpFactory` (`LoggerFactory` impls) + `WinstonLogger`
- winston format stack: bigint/circular-safe serialization, context injection, level→GCP
  `severity` mapping, JSON (GCP) vs colorized pretty (local) rendering
- Mapping the 5 webpieces levels onto winston levels and spreading an `Error` into
  `errName`/`errMessage`/`errStack`

## Out of Scope

- Defining context keys / configuring `HeaderRegistry` (the app does that)
- Providing a `ContextReader` implementation — the node `RequestContextReader` lives in
  `@webpieces/core-context` and is passed into the factory constructor
- Choosing cloud-vs-local at runtime (the app picks which factory to install)
- Browser use (winston is node-only)

## Notes

- Depends only on `@webpieces/core-util` (plus winston / logform / safe-stable-stringify).
- GCP output is stdout JSON scraped by the Cloud Run agent — deliberately no `@google-cloud`
  transport — matching the tested `onetablet/monorepo-nx1` logger.
