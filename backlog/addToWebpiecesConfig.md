# Adding a rule or guard to `webpieces.config.json` — the checklist

> **The five Nx executors this file was originally about are DONE.**
> `validate-architecture-unchanged`, `validate-no-architecture-cycles`, `validate-packagejson`,
> `validate-versions-locked` and `validate-eslint-sync` all read `webpieces.config.json` today and all
> ship `"mode": "RUN_EVERY_TIME"` (see `default-rules.ts`, and the spec that pins that default so an
> upgrade never silently stops a CI gate).
>
> What survived is the CHECKLIST, and it was wrong in two ways that matter. It told you to edit
> `webpieces.config.json` in the same PR as the code — the one edit that hard-blocks every tool call in
> a consumer repo — and it verified with `pnpm run build-all`, which CLAUDE.md forbids. Both are
> corrected below. It also spoke the config's previous vocabulary throughout (`{"enabled": false}`,
> `ignoreModifiedUntilEpoch`, `loadConfig`); the live spellings are `"mode": "OFF"`,
> `turnOffRuleUntilEpoch` and `loadAndValidate`, and the old ones are REJECTED by the validator, so a
> reader following the original text got an error, not a working config.

## THE SEQUENCE — two PRs, and the order is not negotiable

**The validator that runs in this repo is one release BEHIND your source.** `node_modules/@webpieces/*`
are published copies; `tsconfig.base.json` maps `@webpieces/*` to local `src`, so vitest and tsc see
your change and *nothing else does*. Add a new config key in the same PR as the code that reads it and
the INSTALLED validator — which has never heard of the key — rejects it as an unknown rule and blocks
every Bash, Write and Edit in the repo. That is a deadlocked session, and it has happened.

| | PR 1 — SOURCE ONLY | *(publish)* | PR 2 — CONFIG ONLY |
|---|---|---|---|
| touches | `packages/tooling/**` | merging PR 1 auto-publishes | `webpieces.config.json` + the `catalog:` pin in `pnpm-workspace.yaml`, in ONE commit |
| must NOT touch | `webpieces.config.json` | | anything under `packages/` |
| verified by | `nx affected --target=ci` | | `pnpm install`, then `nx affected --target=ci` |

PR 2 is the FIRST point at which the live validator exercises the new key. If it rejects keys that look
correct, the fix is `pnpm install` (the validator is stale) — never deleting the keys.

**Nothing here can wedge a repo**, which is what makes the hard cut safe: editing `webpieces.config.json`
is an unconditional PASS even while the config is invalid, and the config-error banner names the
mechanical cleanup command. "Rejecting it would deadlock the consumer" is not a reason to add a
fallback; it is not true.

## PR 1 — the source change

1. **Config class + `SCHEMA`** — in `rule-configs.ts` (code rules, L3/L4 guards) or
   `main-sync-guard-configs.ts` (the branch-state policy). Data-only, so a class, per CLAUDE.md.
   `SchemaShape<T>` checks key parity between the class and its `SCHEMA` at compile time.
2. **`RULE_SCHEMAS`** — one row in `rule-schemas.ts`, delegating to the class's own `SCHEMA`. This table
   is keyed by **config key**, and a config key is a POLICY, not an implementation class.
3. **`HOOK_GUARD_NAMES`** (guards only) — `sections.ts`. This is what decides which section the key
   belongs in and which hook runs it.
4. **`defaultRules`** — `default-rules.ts`. Say out loud, in a comment, why the default mode is what it
   is; a rule that arrives armed and a rule that arrives OFF are different promises to a consumer.
5. **The rule class** — `AbstractRule` requires BOTH `name` (the operator identity: what a decision-log
   line carries as `rule=`, what a deny report titles itself with) and `configKey` (the entry that
   configures it). They are usually the same string. They are NOT the same when several classes
   implement one policy — see `branch-state-guard` and `pr-lifecycle-guard`.
6. **Register it** — `builtInConfigKeys` and `BUILT_IN_RULE_MAP` in ai-hook-rules (a factory returns an
   ARRAY, so one key may build several rules), or the code-rules registry.
7. **`WebpiecesRulesConfig`** — add the typed field, so the class stays a complete picture of the file.
8. **Retiring something?** — `RETIRED_CONFIG_KEYS` is the ONE place a dead key may be named, and you
   delete its read path in the same change. Set `prunable: false` for anything whose value must carry
   over: `ConfigPruner` deletes `prunable: true` keys, and the error banner actively recommends running
   it. Then check `setup.ts`'s migrator handles your shape — it unions N→1 and fills required fields,
   but a genuinely new shape may need more.
9. **Never leave the old spelling** — no `@deprecated`, no `?? legacyKey`, no second field meaning what
   an existing one means. The compile error, or the validation error naming the destination, IS the
   migration. See CLAUDE.md, "NO webpieces surface is released backwards-compatible".

### Verification for PR 1

```bash
pnpm exec vitest run packages/tooling/rules-config/src packages/tooling/ai-hook-rules/src
pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)
```

The second is the command the PR gate itself runs, over the same scope, which is why a green result
locally is evidence about the gate. **Do not run `pnpm run build-all`** — CLAUDE.md forbids it, and a
whole-workspace build's green tells you nothing the affected build's does not.

**A green build here does NOT prove the key works.** Nx executors, the `wp-*` bins, the PreToolUse hooks
and the ESLint plugin all run the PUBLISHED copy. Verify with the package's own vitest suite (tsconfig
paths → local source), never by regenerating artifacts or by triggering a live guard.

Specs that will need fixture edits in the same PR, or every test in the file fails: `load-config.spec.ts`
(its hardcoded key lists), `validate-config.spec.ts` (including the registry-consistency block),
`guards.spec.ts`, `runner.spec.ts`, `config-pruner.spec.ts`, `setup-migrate.spec.ts`.

## PR 2 — the config change

One commit: bump `'@webpieces/nx-webpieces-rules'` in `pnpm-workspace.yaml` to the release carrying PR 1,
and add the key to `webpieces.config.json`. Then `pnpm install` and the affected build.

## Reuse, do not reinvent

- `loadAndValidate(cwd): LoadedConfig` — from `@webpieces/rules-config`. ONE parse, ONE validation pass,
  everything a consumer needs off the result.
- `seedEntryForRule(key)` — the complete entry at the recommended mode. The validator's paste-ready
  snippet, the installer's seeding and fault Y's deny all call it, so they cannot contradict each other.
- `shouldRun()` on `AbstractRule` — owns `mode: "OFF"` plus both escape hatches. Do not re-implement it.
- `validate-ts-in-src/executor.ts` — the Nx executor to copy when wiring a new one.

## Out of scope / follow-ups

- A CLI `wp-lint-config` that validates `webpieces.config.json` against known keys — the config-error
  banner and `wp-prune-unknown-config` cover most of what it would have done.
