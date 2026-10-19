# Declared rule packs

`webpieces.config.json` selects exact policy packages and repository-relative owner config files.
Policy settings live in those files. The root keeps `commands`, `excludePaths`, and `match-rules`.

```json
{
  "rulePacks": [
    { "package": "@webpieces/code-rules", "config": ".webpieces-config/rules/code.json" },
    { "package": "@webpieces/ai-hook-rules", "config": ".webpieces-config/rules/source.json" },
    { "package": "@webpieces/agent-workflow-rules", "config": ".webpieces-config/rules/workflow.json" },
    { "package": "@webpieces/nx-webpieces-rules", "config": ".webpieces-config/rules/nx.json" },
    { "package": "@webpieces/eslint-rules", "config": ".webpieces-config/rules/lint.json" },
    { "package": "./client-policy/manifest.cjs", "config": ".webpieces-config/rules/client.json" }
  ],
  "commands": { "pr-gate": { "mode": "OFF", "buildCommand": "pnpm test", "gates": [] } },
  "excludePaths": [],
  "match-rules": []
}
```

Choose the packs your repository uses; installed dependencies are never inferred as selected packs.
Each package exports `rule-pack`. An explicit local manifest module (`.js`, `.cjs`, `.mjs`, or a `.ts` / `.cts`
module transpiled in memory when it loads) is also supported. A repository's own rules are written as
`LocalRule` classes and declared through one `LocalRulePack` module; see "Repo-local rules" in the
`@webpieces/webpieces-tooling` README.
A package declaration must agree with its manifest's owner name. Paths must stay inside the repository,
including through symlinks, and each owner must have a distinct config file.

Hook installation writes the owners' recommended entries into the declared files for review. Existing
modes, hatches and options remain explicit. Loading never supplies required settings, including for `OFF`
policies. Optional tuning is merged only into resolved execution options; it is never added to raw policy
config.

An owner file maps canonical policy IDs directly to config objects. Unknown policies, settings in another
owner's file, unknown fields, retired fields, missing required values, and incompatible manifest/schema
APIs fail with the named repair file and the exact entry to paste or delete — a missing entry prints the
owner's recommended seed, ready to paste. Fixed and experimental safeguards remain outside configurable
policies.

There is no generated, committed artifact beside the owner files. The installed release's version is pinned
once, by the `pnpm-workspace.yaml` catalog and `pnpm-lock.yaml`; owners, schemas and contributions are read
from the installed manifests on every load. So a release that changes no rule needs no command and produces
no diff, and a release that adds a required rule produces one deny naming the file and the entry to paste.

A previous flat root (`rules` / `hookGuards`) is refused with the edit to make: declare `rulePacks`, move each
entry into the owner file its pack declares, and delete the retired sections. Nonempty directory-based
implementations require a declared client pack with owned schemas and runtime modules; inherited settings must
be made explicit.

A client manifest exports `rulePackManifest` using SDK manifest API 3 and schema API 1. It owns configurable
schemas, optional tuning, recommended seeds, help and migrations. Contributions identify their canonical
owner, execution kind, and implementation module. Build, source-hook, workflow-guard and lint factories are
loaded only when their execution family runs; metadata validation does not import implementations.

`NodeRulePackModuleLoader`, `RulePackDiscovery`, `PackPolicyFiles` and `RuleRuntimeModules` resolve through the
client's dependency graph, including an isolated pnpm umbrella install. The framework has no concrete owner
imports or discovery list. Client implementations use the same contract as shipped execution packs.

When config is invalid, every problem is a normal deny naming the file to edit and the exact entry — never a
hook crash. Reads and inspection remain available. Writes to `webpieces.config.json`, `.gitignore`,
everything under `.webpieces-config/` and any declared owner file are allowed before validation, as are the
anchored install, prune and `wp-migrate-dirs` commands a deny can name. Unrelated writes, escaping symlinks,
mixed patches and chained mutating commands stay blocked.

## Repository directories

Commit `.webpieces-config/`: the selected owner settings.
Keep all generated runtime files under `.webpieces/`, and ignore it with exactly one entry:

```gitignore
.webpieces/
```

`.webpieces/` is the gitignored local state directory (logs, trash, pr-review, merge state, tasks)
and stays where it is. `pnpm wp-migrate-dirs` moves ONLY the committed policy that releases up to
0.4.910 kept inside it — `rules/**`, plus any
declared owner file under `.webpieces/` or `.webpieces-logs/` — into `.webpieces-config/`, rewrites the
declarations, and removes the old ignore exceptions. It never walks the rest of `.webpieces/`, so state
such as pnpm symlinks under `trash/` can never fail it (#1254). A `.webpieces-logs/` left by
0.4.911–0.4.914 is renamed back to `.webpieces/` when that name is free, and is otherwise left in place.
Hook installation and `wp-upgrade-shim` also perform the migration.
Conflicting destinations fail before files move; identical files support interrupted reruns.
Normal loading refuses only policy still left inside `.webpieces/`, and any owner file declared in a
runtime directory.

In a Git checkout, every declared owner file must be tracked and
must not match any ignore pattern, even if it was force-added previously. After reviewing a
migration, `pnpm wp-migrate-dirs --stage` explicitly stages the new policy and declaration.
Commit the deletion of the old policy paths as well. The migration command remains allowed
while configuration is invalid, and `.gitignore` remains editable for policy-ignore repairs.
Standalone validation outside a Git checkout still checks config without an index.
