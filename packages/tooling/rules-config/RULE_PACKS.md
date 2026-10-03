# Declared rule packs

`webpieces.config.json` selects exact policy packages and repository-relative owner config files.
Policy settings live in those files. The root keeps `commands`, `excludePaths`, and `match-rules`.

```json
{
  "rulePacks": [
    { "package": "@webpieces/code-rules", "config": ".webpieces/rules/code.json" },
    { "package": "@webpieces/ai-hook-rules", "config": ".webpieces/rules/source.json" },
    { "package": "@webpieces/agent-workflow-rules", "config": ".webpieces/rules/workflow.json" },
    { "package": "@webpieces/nx-webpieces-rules", "config": ".webpieces/rules/nx.json" },
    { "package": "@webpieces/eslint-rules", "config": ".webpieces/rules/lint.json" },
    { "package": "./client-policy/manifest.cjs", "config": ".webpieces/rules/client.json" }
  ],
  "commands": { "pr-gate": { "mode": "OFF", "buildCommand": "pnpm test", "gates": [] } },
  "excludePaths": [],
  "match-rules": []
}
```

Choose the packs your repository uses; installed dependencies are never inferred as selected packs.
Each package exports `rule-pack`. An explicit local JavaScript manifest module is also supported.
A package declaration must agree with its manifest's owner name. Paths must stay inside the repository,
including through symlinks, and each owner must have a distinct config file.

Run `pnpm wp-rules-sync` to write missing owner-recommended entries and required fields. Existing modes,
hatches and options remain explicit. Loading never supplies required settings, including for `OFF` policies.
Optional tuning is merged only into resolved execution options; it is never added to raw policy config.
Review and commit every change before relying on newly written settings.

An owner file maps canonical policy IDs directly to config objects. Unknown policies, settings in another
owner's file, unknown fields, retired fields, missing required values, and incompatible manifest/schema
APIs fail with the named repair file. Fixed and experimental safeguards remain outside configurable policies.

`pnpm wp-rules-sync` also generates `.webpieces/rules.lock.json` and
`.webpieces/instruct-ai/rules-catalog.md` from the same resolved registry. The lock records package versions,
manifest digests, schema APIs, owners and implementation contributions. The catalog names actual config
files, modes, contributors and owner-authored remediation. Loading checks exact artifact agreement and
never rewrites files. Config limits alone do not change the manifest lock.

To migrate a previous flat root, run the explicit upgrade command:

```sh
pnpm wp-rules-sync --upgrade --pack=@webpieces/code-rules=.webpieces/rules/code.json --pack=@webpieces/ai-hook-rules=.webpieces/rules/source.json --pack=@webpieces/agent-workflow-rules=.webpieces/rules/workflow.json --pack=@webpieces/nx-webpieces-rules=.webpieces/rules/nx.json --pack=@webpieces/eslint-rules=.webpieces/rules/lint.json
```

Only this upgrade operation may read the previous package.json selection metadata and flat root settings.
Normal loading selects packs only through root declarations and rejects flat settings. Nonempty directory-based implementations require a declared client pack with
owned schemas and runtime modules; inherited settings must be made explicit before upgrading. Sync validates
all planned config and artifact data before writing, writes atomically, and commits the root declaration last.

A client manifest exports `rulePackManifest` using SDK manifest API 3 and schema API 1. It owns configurable
schemas, optional tuning, recommended seeds, help and migrations. Contributions identify their canonical
owner, execution kind, and implementation module. Build, source-hook, workflow-guard and lint factories are
loaded only when their execution family runs; metadata validation does not import implementations.

`NodeRulePackModuleLoader`, `RulePackDiscovery`, `PackPolicyFiles` and `RuleRuntimeModules` resolve through the
client's dependency graph, including an isolated pnpm umbrella install. The framework has no concrete owner
imports or discovery list. Client implementations use the same contract as shipped execution packs.

When config is invalid, reads and inspection remain available. Exact root, declared owner, lock and catalog
repair writes are allowed before validation, as are anchored install, sync and prune commands. Unrelated
writes, undeclared config files, escaping symlinks, mixed patches and chained mutating commands stay blocked.
