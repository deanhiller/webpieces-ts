# Packaging: bins and the umbrella

Moved verbatim out of `CLAUDE.md`. Read this when you touch a `package.json` `bin` / `publishConfig`,
the publish script, `pnpm-workspace.yaml`'s catalog, or a `workspace:` dependency between
`packages/tooling/*`.

### No bin shims — every `bin` lives in `publishConfig.bin`

**RULE: a package declares its executables in `publishConfig.bin`, pointing at compiled TypeScript
(`./src/**/<entry>.js`). NEVER a top-level `bin`, and NEVER a committed `.js` shim.**

The hazard this defuses: pnpm `chmod`s every `bin` target while it links a package, and a `workspace:`
sibling is linked from its SOURCE directory, where `src/` holds only `.ts` until tsc runs. A top-level
`bin` pointing at compiled output therefore makes every `pnpm install` print
`WARN Failed to create bin ... ENOENT ... chmod` — 28 of them on this workspace, noise indistinguishable
from a real bin-link failure.

`publishConfig.bin` removes the hazard instead of working around it: the source manifest declares no
`bin`, so there is nothing for pnpm to chmod, and the published manifest gets one anyway.

**THE HOIST IS DONE BY `scripts/publish-packages.sh`, NOT by the package manager.** `pnpm pack` and
`pnpm publish` hoist `publishConfig.bin` into `bin` on their own — but **CI publishes with
`npm publish dist/<dir>`, and npm does NOT**. It treats `publishConfig.bin` as an unknown key and leaves
it there. Verifying the move with `pnpm pack` therefore proved nothing about the release, and **0.4.575
shipped with no `bin` at all in any of the four packages** — every `wp-*` command gone. So the script
hoists it into the DIST manifest before publishing (the ENOENT hazard is a property of the SOURCE tree —
pnpm never links from `dist` — so the published manifest can carry an ordinary `bin` with no downside),
and then FAILS THE RELEASE if any package whose source declares bins would publish a different number.

The general rule that incident bought: **verify a packaging change against the artifact the RELEASE
pipeline produces, not the one your local package manager produces.**

That matters because the two earlier cures were both worse than the disease, and the second one shipped
a live incident:

- **A committed `.js` shim per bin.** Seventeen files exempt from `no-js-files`, carrying none of the
  TypeScript rules this repo enforces.
- **Deleting the `workspace:` dependency instead** (PR #585). `@webpieces/ai-hook-rules` and
  `@webpieces/pr-gate` are not imported by `nx-webpieces-rules` — they are BUNDLED by it — so they read
  as phantom deps and were removed. One release later they were gone from every consumer's tree,
  `wp-ai-guards-hook` vanished from `node_modules/.bin`, and the L0 shim blocked every tool call while
  prescribing a `pnpm install` that could not possibly help (fault `U`).

`bin-targets-exist.spec.ts` and `umbrella-bundles-all.spec.ts` (nx-webpieces-rules) enforce both halves
and need no maintenance. `setupDebugging.md` is a HISTORICAL journal of an abandoned postinstall
approach; its shim advice is superseded by this section.

### The umbrella: consumers depend on ONE package

**RULE: `packages/tooling/*` depend on each other with `workspace:*`. The ROOT manifest depends on the
PREVIOUS RELEASE of `@webpieces/nx-webpieces-rules` alone, via the one `catalog:` entry in
`pnpm-workspace.yaml`.**

These are two different things and conflating them is what caused the incident above:

| | specifier | why |
|---|---|---|
| BUILDING the tooling | `workspace:*` between `packages/tooling/*` | built against local source; this is also what draws `nx-webpieces-rules` above its five children in `architecture/dependencies.json` — nx only draws workspace→workspace edges |
| RUNNING the tooling on this repo | `catalog:` in the ROOT manifest | the repo is validated by the previous published release (see `.claude/rules/published-vs-local-source.md`) |

`nx-webpieces-rules` is tagged `role:bundle`: it aggregates `ai-hook-rules`, `code-rules`,
`eslint-rules`, `pr-gate` and `rules-config`, so **one** dependency line delivers every `wp-*` bin, every
eslint rule and every nx executor. A consumer repo should never name the children directly.

So the catalog needs exactly one entry — the umbrella pins its children in lockstep, by construction, and
listing them separately is five more versions to keep in step plus an invitation to the partial bump the
L0 drift guard exists to catch. **Bumping the release the repo is built with is a one-line edit in
`pnpm-workspace.yaml`.**

A dependency nothing imports is not automatically phantom. For a `role:bundle` package the
`dependencies` block IS the product.
