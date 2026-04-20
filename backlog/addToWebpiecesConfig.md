# Wire remaining Nx executors into `webpieces.config.json`

## Summary

6 Nx infrastructure executors in `packages/tooling/nx-webpieces-rules/src/executors/` hardcode their behavior and ignore `webpieces.config.json`. Unlike every other rule in the system, they can't be disabled or epoch-gated. Wire them up so users can set `{"enabled": false}` or `ignoreModifiedUntilEpoch` on them the same way they do for every other rule.

## Scope — the 6 executors that need wiring

Each already exists as a working Nx executor; they just don't read `webpieces.config.json` today.

| Executor file | Proposed config key | Epoch-gateable? |
|---|---|---|
| `packages/tooling/nx-webpieces-rules/src/executors/validate-architecture-unchanged/executor.ts` | `validate-architecture-unchanged` | yes (diff comparison) |
| `packages/tooling/nx-webpieces-rules/src/executors/validate-no-architecture-cycles/executor.ts` | `validate-no-architecture-cycles` | yes (cycle set) |
| `packages/tooling/nx-webpieces-rules/src/executors/validate-no-skiplevel-deps/executor.ts` | `validate-no-skiplevel-deps` | yes (edge set) |
| `packages/tooling/nx-webpieces-rules/src/executors/validate-packagejson/executor.ts` | `validate-packagejson` | no — enabled/disabled only |
| `packages/tooling/nx-webpieces-rules/src/executors/validate-versions-locked/executor.ts` | `validate-versions-locked` | no — enabled/disabled only |
| `packages/tooling/nx-webpieces-rules/src/executors/validate-eslint-sync/executor.ts` | `validate-eslint-sync` | no — enabled/disabled only |

## Scope — what is NOT included and why

- **ESLint rules** (8 of them in `packages/tooling/eslint-rules/src/rules/`): already toggleable via ESLint's native `'off'` in `eslint.webpieces.config.mjs`. Their CI-enforcement counterparts (`validate-modified-files`, `validate-modified-methods`, `validate-catch-error-pattern`, `validate-no-unmanaged-exceptions`) already honor `webpieces.config.json`. Keep the separation: ESLint for IDE feedback, Nx for CI gates with config semantics.
- **ai-hook rules** (9 of them in `packages/tooling/ai-hook-rules/src/core/rules/`): already indirectly configured. `packages/tooling/ai-hook-rules/src/core/runner.ts:35` calls `loadConfig(cwd)` and filters rules by `enabled`. No change needed.

## Approach

1. **Add default entries** in `packages/tooling/rules-config/src/default-rules.ts` — add all 6 new keys, each `{ enabled: true }`. For the 3 that support it, document `ignoreModifiedUntilEpoch` as a supported option.
2. **Add a helper** in `packages/tooling/rules-config/src/index.ts` — e.g. `isRuleEnabled(config: ResolvedConfig, key: string): boolean`. Returns `true` if the rule entry is absent (fail-safe) or `enabled !== false`.
3. **Per-executor integration** — at the top of each of the 6 `executor.ts`:
   ```ts
   const config = loadConfig(context.root);
   if (!isRuleEnabled(config, '<rule-key>')) {
       console.log('⏭  Skipped: <rule-key> disabled in webpieces.config.json');
       return { success: true };
   }
   ```
4. **Epoch gating** for the 3 diff-based executors (`validate-architecture-unchanged`, `validate-no-architecture-cycles`, `validate-no-skiplevel-deps`): read `ignoreModifiedUntilEpoch` from the rule options. If `Date.now() / 1000 < epoch`, log a "grandfathered until $DATE" notice and return `{ success: true }`. For `packagejson` / `versions-locked` / `eslint-sync`: all-or-nothing — skip the epoch logic.
5. **Tests** — add spec files next to each executor, mirroring the existing `packages/tooling/rules-config/src/load-config.spec.ts` style. At minimum cover: (a) default `enabled: true` runs normally, (b) `enabled: false` returns success with a skip message, (c) for epoch-gated executors, `ignoreModifiedUntilEpoch` set in the future returns success.
6. **Docs** — update `webpieces.config.json` at repo root to include the 6 new keys with their defaults so users discover them.

## Key existing utilities to reuse

- `loadConfig(cwd: string): ResolvedConfig` — from `@webpieces/rules-config`, already used by `validate-ts-in-src/executor.ts` and the ai-hook runner. Do not reinvent.
- `ResolvedConfig.rules: Map<string, ResolvedRuleConfig>` — typed already at `packages/tooling/rules-config/src/types.ts:29-43`.
- `ResolvedRuleConfig.options` — bag-of-options pattern; consumers cast the fields they understand.
- Pattern reference: `packages/tooling/nx-webpieces-rules/src/executors/validate-ts-in-src/executor.ts` is the one Nx executor that already does this correctly — use it as the template.

## Verification

- `pnpm run build-all` passes (TS + lint + circular checks).
- Unit tests for each executor: the 3 behaviors above.
- Integration: put `{"validate-architecture-unchanged": {"enabled": false}}` into `webpieces.config.json`, run `nx run architecture:validate-architecture-unchanged`, see it skip with the "disabled" message. Revert, confirm it runs as before.

## Out of scope / follow-ups

- Updating downstream repos (e.g. `../baseNxMonorepo`) to use the new keys — they'll pick them up automatically when they bump the published `@webpieces/nx-webpieces-rules` version.
- A CLI `wp-lint-config` that validates `webpieces.config.json` against known keys — separate follow-up.
