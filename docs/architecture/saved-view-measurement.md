# Saved-view command measurement (#1096)

Measured locally on 2026-10-03 using Nx 22.0.2, Node 22.21.1, and ten small
TypeScript library projects. These are illustrative command measurements, not a
prediction for the OneTablet consumer. That consumer's historical 37,781 ms scan
and 2.61 ms HTML-render measurements in #1096 are separate component timings.

The isolated workspace ran the local source executors through `nx:run-commands`
with SWC/tsconfig-paths registration. The baseline reproduced the old visualization
prerequisite (`dependsOn: ['generate']`); the after targets removed that prerequisite.
Both flows used the same source executors and saved-artifact format. Generation
really ran the Nx graph builder, TypeScript API scanner, and artifact writers.
Browser opening was stubbed to return false, and the browser client text was
injected at the renderer boundary so a package build was not required. DOT/HTML
rendering and saved-data loading ran normally. The runtime fixture had no service
edges. Rule modes were OFF **only in this disposable fixture**; repository
validation and CI were unchanged. Pack modules were resolved to local source to
exercise this checkout rather than the installed release.

| Public command | Before, total wall time | After, total wall time | Before source scan | After source scan |
|---|---:|---:|---:|---|
| `pnpm arch:visualize` | 3.97 s | 1.21 s | 1,299.23 ms | Not invoked |
| `pnpm arch:visualize-runtime` | 3.46 s | 1.02 s | 1,169.15 ms | Not invoked |

The generator executor took 1,516.63 / 1,451.19 ms in the two baseline commands.
View executor timings were 12.33 → 11.95 ms (compile graph) and
40.54 → 48.79 ms (runtime graph). Those executor timings include loading/rendering,
not process startup. End-to-end times include pnpm, Nx scheduling/graph loading,
Node startup, SWC and source-module loading. A separate empty Nx run-command target
measured 0.51 s of startup/scheduling overhead; it is not a subtraction-based renderer
estimate. The expected improvement comes from removing the generation task,
not accelerating the renderer or eliminating Nx startup.

## Reproduction outline

1. Create a disposable Nx workspace with ten independent `framework:node`,
   `role:lib` projects, one source file and a responsibilities document per project.
2. Run local generation and visualization executors through uncached
   `nx:run-commands` targets with the same context root. Instrument
   `scanAndAttachApiRelations` and executor elapsed time with `performance.now()`.
3. For the baseline, set both view targets to depend on `generate`; time each
   public npm command with `/usr/bin/time -p`.
4. Remove only those generation prerequisites, then time the same commands again.
5. Use `NX_DAEMON=false NX_ISOLATE_PLUGINS=false` consistently. Verify baseline
   logs contain generator/scanner output and after logs contain only the view task.

Focused tests independently assert the **real plugin's inferred target definitions**
contain no generation prerequisites, retain validation dependencies, preserve
custom graph paths, and leave compile/API/runtime fact files unchanged after source
edits. They render both pages from older saved artifacts, verify snapshot messaging
and browser fallback paths, check malformed/missing artifacts, and load a newly
written snapshot on subsequent viewing. Existing renderer tests cover menus,
API relationship labels, and graph interactions.

## Installed release verification (#1104)

After release run [37106667039](https://github.com/deanhiller/webpieces-ts/actions/runs/37106667039)
completed successfully, this repository installed the published
`@webpieces/webpieces-tooling` 0.4.848 bundle. All four selected rule owners
migrated to explicit owner config files; all 50 existing policy values were
compared with the previous config and preserved exactly.

The real installed Nx plugin inferred both view targets with `cache: false`
and no generation prerequisites. With a temporary source file added, the public
`pnpm arch:visualize` and `pnpm arch:visualize-runtime` commands both succeeded
and opened the browser. SHA-256 hashes of the compile graph, runtime graph, and
six API contracts were identical before and after viewing. Neither command's
log contained generator or source scanner execution. Both HTML pages included
the saved-snapshot, unknown-freshness, and explicit-refresh guidance.

Observed public-command wall times were 29.05 s and 19.95 s respectively in
this checkout. They include pnpm/Nx/plugin startup and browser opening; these
are single smoke runs, not a controlled speed comparison or a consumer
performance guarantee.

A direct installed `architecture:visualize` invocation with a missing custom
graph path exited 1, printed the explicit generation cure, and did not create
the missing artifact. The temporary source file was then removed. A separate,
explicit `pnpm arch:generate` succeeded and refreshed committed command guidance.

Reproduce by hashing `architecture/dependencies.json`,
`architecture/runtime-dependencies.json`, and `architecture/apis/*.json`,
adding a temporary source-only edit, and running both public view commands.
Check hashes and logs before removing the edit and explicitly generating.

The upgrade gate also exposed a stale PR-command test fixture that read the
removed root `rules`/`hookGuards` maps. It now reads the declared owner files
before feeding the existing frozen test-only policy transport. Runtime config
loading still accepts only the owner-file shape; this repair adds no production
compatibility path and changes no consumer policy values.
