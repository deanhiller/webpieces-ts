# Responsibilities — code-rules

Build-time code validation gate. Standalone (no Nx dependency) CLI that validates new and modified code against the shared rule set over a git diff, enforcing method/file limits, return types, no-any, DI-token, exception, controller-naming and related rules in CI.

## In Scope

- Build/CI-time validators run over changed files/methods (`validate-new-methods`, `validate-modified-methods`, `validate-modified-files`, per-rule `validate-*`).
- Diff-scoped enforcement: only new/modified code is gated, using rules-config diff-scope helpers.
- Project-scoped API security enforcement (`ensure-we-are-secure`): a directly changed project is
  audited in full for explicit method-level `@WpAuth*` HTTP policy or IPC-only
  `@WpInternal`/`@WpIpcEndpoint` contracts. Decorators are recognized by canonical import provenance.
- The two `role:api-lib` spelling rules (#1023), sharing `ApiLibSourceRule`: `one-enum-spelling-in-api-lib`
  (a fixed set of string values is a string enum with every member string-initialised — refuses literal
  unions, `(typeof X)[number]`, `keyof typeof X`, single-literal discriminators and numeric / heterogeneous /
  `const` / uninitialised enums, printing the enum to write) and `no-inline-import-in-api-lib` (refuses
  `import('…')` type nodes and dynamic `import()` expressions). Both are parser-only and THROW a
  `RuleFailError` with one `Option` per site; `mode` has no default.
- `no-utility-types-in-api-lib` (#1026), also on `ApiLibSourceRule` but scoped by its required `paths`
  globs: refuses `Omit` / `Pick` / `Partial` / `Required` / `Exclude` / `Extract` in an api contract (an
  `extends` clause, a field, an alias, a generic argument), printing the write-the-fields-out cure.
- The whole-scope modes (#1027): `RuleScopePlanner` turns a diff-scoped rule's `MODIFIED_PROJECTS` /
  `RUN_EVERY_TIME` into its per-file mode run inside a widened `FileScope` — once, for every rule.
- The debug run (`--rule` / `--mode` / `--projects` on `wp-validate-code` and the nx `validate-code`
  executor): one rule, labelled as not the gate, its own failure text plus a site count per project
  (`DebugRunReport`), non-zero when there are sites; no config edit.
- CLI entry points and orchestration: `wp-validate-code` and the `wp-ci` gate runner, one shared composition root (`CodeRulesBootstrap`), reporting (`rule-reporter`), mode resolution.
- Standalone `CodeValidator` executor consumable without the Nx toolchain.

## Out of Scope

- Config schema, typed `*Config` classes, mode unions, defaults, and config loading (rules-config).
- Edit-time PreToolUse/hook interception and fix-hint UX for AI agents (ai-hook-rules).
- Nx executor/target wiring (nx-webpieces-rules).

## Notes (optional)

Runs at build/CI time as a gate on the committed diff — the after-the-fact counterpart to ai-hook-rules' edit-time enforcement, both drawing rule config from rules-config. Dist bins load the PUBLISHED rules-config from node_modules, so new shared symbols need co-release.

`ensure-we-are-secure` is configured with `"mode": "MODIFIED_PROJECTS"`. Here that means projects
that directly own a changed file, not their transitive Nx dependents. Once selected, every owned
production TypeScript file in the project is audited, including unchanged API files. Test/spec
fixtures are excluded so negative contract tests remain possible. HTTP contracts require
`@ApiPath` plus exactly one method-level canonical `@WpAuth*` on each `@Endpoint`;
`@WpAuthPublic` requires an inline non-empty reason. IPC contracts require class-level
`@WpInternal('api-id')` plus method-level `@WpIpcEndpoint('method-id')`, and cannot mix HTTP
annotations. Recognition follows imports from `@webpieces/core-util` / `@webpieces/core-util/ipc`,
including aliases and namespace imports, so a local decorator with the same spelling cannot satisfy
the rule. Only the universal branch/epoch turn-offs apply; there is no source annotation bypass.
