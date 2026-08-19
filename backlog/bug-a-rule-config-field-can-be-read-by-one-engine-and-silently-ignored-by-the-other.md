# BUG: a rule-config field can be honoured by one engine and silently ignored by the other, with no diagnostic anywhere

**Packages:** `@webpieces/rules-config` (declares the schema), `@webpieces/ai-hook-rules` (edit-time
engine), `@webpieces/code-rules` (CI engine)
**Severity:** High — the failure is silent by construction.

## The shape

Every rule has ONE config object, declared once in `rules-config/src/rule-configs.ts`, and TWO
consumers: the edit-time hook rule and the CI validator. `code-rules-config-table.ts` injects the
*same* config object into the CI half, so a field the CI half never reads still parses cleanly and
raises no "unknown field". Nothing anywhere says the key did not apply.

The observed instance was `no-custom-css.allowGlobs`: declared in `NoCustomCssConfig.SCHEMA`,
short-circuited on by `NoCustomCssRule.check`, and never mentioned in `validate-no-custom-css.ts`.
A consumer wrote `allowGlobs`, watched the editor go quiet, and kept failing CI on the exact files
it had exempted — then reached for `disableAllowed: true` / `turnOffRuleUntilEpoch` (a permanent
escape, or a repo-wide hatch) to work around a per-path exclusion that was supposed to exist.

**That one instance is FIXED** — both engines now narrow their path set through the shared
`NoCustomCssScope` in `rules-config`, so the exemption cannot be honoured by one and forgotten by
the other, and `validate-no-custom-css.test.ts` locks the CI half to it. What is NOT fixed is the
class of bug: `NoCustomCssScope` is one rule's answer, not a mechanism.

## The two candidate guards

Either one would have surfaced this at the moment the key was written:

1. **Fail the load** when a rule's config carries a field the receiving engine never reads. The
   engines already share `RULE_SCHEMAS`, so the set of fields each consumes is knowable.
2. **Warn at validation time** when an optional field is present and unused — the shape the
   home-config loader already uses for an unknown key ("`_doc` is not a key this @webpieces release
   understands, so it was IGNORED and had NO effect"). That message does not exist for the per-rule
   config path.

## Worth grepping for the same asymmetry

- `excludePackages` / `excludeRegExp` on `no-file-import-cycles`
- `allowedRootFiles` / `excludePaths` on `validate-ts-in-src`
- `disableAllowed` across every rule that declares it

## Also worth doing while here

`globToRegex` still has hand-rolled copies in `ai-hook-rules/rules/no-symbol-di-tokens.ts`,
`code-rules/validate-no-symbol-di-tokens.ts` and `pr-gate/dashboard/dashboard.ts`, alongside the
shared minimatch-backed `matchesAnyGlob` in `rules-config/exclude-paths.ts`. Several glob dialects
in one repo is exactly how two halves of one rule drift — `no-symbol-di-tokens` has the same
two-engine/one-config shape and its own `allowedPaths`.
