# BUG: runtime visualizer emits UNESCAPED quotes around serviceName, so the DOT will not parse (0.4.461)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.461` (regression introduced by #475)
**Severity:** High — **the runtime diagram does not render at all.** Every server that declares
`metadata.webpieces.serviceName` produces an invalid node line, so the whole graph fails to parse. The
feature #475 added is exactly what breaks it: a repo that adopts `serviceName` (which #475 asks you to
do) loses its visualization completely.

## Symptom

`nx run architecture:visualize-runtime` writes the HTML, and opening it shows only:

```
Error: syntax error in line 7 near '-'
```

No graph. Nothing else on the page.

## Root cause: the service name is interpolated into the DOT label with bare `"`

Generated `tmp/webpieces/runtime-architecture.dot`, line 7:

```dot
  "helper-fsdb-svr" [fillcolor="#E8F5E9", label="helper-fsdb-svr\n(server, L0, "helper-fsdb")\nimplements: ..."];
                                                                              ^            ^
                                                                              bare quotes inside a quoted string
```

In DOT, the `"` before `helper-fsdb` TERMINATES the `label` string. The parser then sees `helper-fsdb`
as bare tokens and fails on the `-` — hence `syntax error in line 7 near '-'`.

It only triggers for nodes that HAVE a declared service name, which is why line 6 (`agent-listener`, a
client with no serviceName) is fine and line 7 is the first server. In the consuming repo all 4 servers
declare one, so 4 of 7 node lines are malformed:

```
"helper-fsdb-svr" ... label="helper-fsdb-svr\n(server, L0, "helper-fsdb")\n...
"helper-svr"      ... label="helper-svr\n(server, L1, "helper-portal")\n...
"lang-fsdb-svr"   ... label="lang-fsdb-svr\n(server, L0, "lang-fsdb")\n...
"lang-server"     ... label="lang-server\n(server, L1, "lang")\n...
```

Confirmed mechanically: escaping just those quotes (`\"`) and running `dot -Tsvg` parses the file with
exit 0 and no diagnostics. Nothing else in the generated DOT is invalid.

## Suggested fix

1. Escape the service name when composing the label — `\\"` in the emitted string, so the DOT contains
   `(server, L0, \"helper-fsdb\")`. Verified sufficient.
2. Or drop the quotes entirely: `(server, L0, helper-fsdb)` reads fine and cannot break.
3. **Better, and the reason this shipped:** run every generated DOT through a parse check before
   writing it (or at minimum escape ALL interpolated values through one helper rather than inlining
   them at each call site). This bug is invisible to the generator — `architecture:generate` and
   `validate-runtime-architecture` both pass, because nothing parses the DOT. Only a human opening the
   HTML sees it. A DOT that no one validates is a DOT that will break again.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` — node emit; the `(role, L<n>, "<serviceName>")` label composition added by #475
- `packages/tooling/nx-webpieces-rules/src/executors/visualize-runtime/executor.ts` — writes the `.dot`/`.html`; the natural place for a parse check

## Acceptance check

1. A repo where a server declares `metadata.webpieces.serviceName` renders its runtime graph with no
   parse error, and the node shows the service name.
2. A service name containing a character that is special in DOT still renders (escaping is applied,
   not assumed unnecessary).
3. Ideally: generating a DOT that fails to parse is itself a build failure, rather than something only
   discovered by opening the page.
