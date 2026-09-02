# FEATURE: `max-file-lines` has no path exemption, so generated code hard-blocks every PR that touches it

**Packages:** `@webpieces/rules-config`, `@webpieces/nx-webpieces-rules` (the `max-file-lines` rule),
`architecture:validate-code`
**Version seen:** `0.4.714`
**Severity:** High — it is a **hard stop with no escape hatch**, it fires on files nobody wrote, and
the only available workaround is a global off-switch that disables the rule for hand-written code too.

## Symptom

`mealco-internal/monorepo-nx` cannot open a PR that touches any GraphQL codegen output:

```
max-file-lines: services/public-api/src/__generated__/graphql.ts is 42,187 lines (limit 902)
```

Existing, already-committed examples in that repo:

```
services/stores-manager/src/__generated__/graphql.ts   43,718 lines
services/orders-manager/src/__generated__/graphql.ts   43,910 lines
```

These are `graphql-codegen` **client-preset** output. The preset embeds the *entire* Hasura schema
type graph, not merely the operations the service uses, so the size is a property of the upstream
schema and is completely outside the repo's control. No amount of good engineering makes these files
902 lines.

The rule's config is:

```jsonc
"max-file-lines": {
  "limit": 902,
  "mode": "NEW_AND_MODIFIED_FILES",
  "disableAllowed": false,          // <- no per-file/per-line escape
  "turnOffRuleUntilEpoch": 1788220799,
  "turnOffRuleWhileOnBranch": null
}
```

`disableAllowed: false` means there is no inline suppression. `mode: NEW_AND_MODIFIED_FILES` means it
fires the moment a PR *touches* such a file — including a regeneration nobody hand-edited.

## Why this is a design gap, not a config mistake

**The exemption mechanism already exists, and is already used for exactly this case — on a different
rule.** From the same `webpieces.config.json`:

```jsonc
"no-function-outside-class": {
  "allowedPaths": ["**/__generated__/**"],   // <-- the exact pattern, for the exact reason
},
"no-js-files":  { "allowedPaths": ["services/ai-chat/jest.config.js"] },
"nx-wiring":    { "allowedPaths": ["packages/http/http-client/**", "libraries/apis/external/**", "tools/**"] },
```

So `**/__generated__/**` is already an understood, accepted exemption for generated code. Adding
`allowedPaths` to `max-file-lines` was tried first and the validator **rejected it as an unknown
field for this rule** — the support is simply absent, per-rule, rather than deliberately withheld.

**Secondary observation — the field name is inconsistent.** At least one other rule uses
`excludePaths` (`["scripts", "tmp", "architecture", "libraries/kami", "tools"]`) rather than
`allowedPaths`, for what appears to be the same concept. Two names for one idea, each available on a
different arbitrary subset of rules, is hard to discover and hard to reason about.

## The ask

1. **Support `allowedPaths` on `max-file-lines`.** A line-count rule is the single rule most certain
   to be tripped by machine-generated files, and it is currently the one rule that cannot exempt them.
2. **Consider a default.** `**/__generated__/**` (and `dist/**`, `*.generated.ts`) failing a
   *line-count* rule is never a useful signal. A sensible built-in default would mean no consumer has
   to discover this at all.
3. **Unify `allowedPaths` vs `excludePaths`** into one field name available on every path-scoped rule,
   with the other accepted as a deprecated alias.

## Why the current workaround is bad, specifically

The only thing a human can do today is push `turnOffRuleUntilEpoch` forward. That is a **global**
off-switch: while the window is open the rule is off for *hand-written* files too, which is precisely
when a real 1,500-line service class slips in unnoticed. So the mechanism protecting the codebase
gets disabled by the need to accommodate files the codebase did not write.

It also expires silently. In this repo the hatch lapsed on 2026-08-31 and the breakage surfaced on
2026-09-02 as an unrelated-looking PR failure, mid-incident, on a change that had nothing to do with
file length. The person hitting it has no context for why a line-count rule is suddenly blocking a
one-word GraphQL fix.

## Also worth stating: the guidance tells agents to stop, and they do

The tool output says a human must set `turnOffRuleUntilEpoch` and that AI agents should not. That is
good guidance and the agent obeyed it correctly — but the result is that **the only route past a rule
firing on generated code is to interrupt a human**, every time the epoch lapses, on work unrelated to
the rule's purpose. `allowedPaths` removes the interruption entirely rather than rationing it.

## Done when

* `max-file-lines` accepts `allowedPaths` and honours it
* generated-code globs are exempt by default, or at minimum documented as the recommended config
* `allowedPaths` / `excludePaths` are one field name across every path-scoped rule
* a repo does not have to disable a rule globally in order to tolerate a file it did not author

---

## STATUS — asks 1 and 2 SHIPPED; ask 3 DEFERRED (and partly re-diagnosed)

**Shipped in this same commit:**

1. `max-file-lines.allowedPaths` exists, on the SAME field name, matcher (`isPathExcluded`) and
   semantics as `no-function-outside-class` / `no-js-files` / `no-destructure`. Honoured by BOTH
   engines — the edit-time hook (`ai-hook-rules/src/core/rules/max-file-lines.ts`) and the build-time
   validator (`code-rules/src/validate-modified-files.ts`).
2. Generated code is exempt with **no configuration at all** — `GENERATED_CODE_PATHS`
   (`rules-config/src/generated-code-paths.ts`): `**/__generated__/**`, `**/generated/**`,
   `**/*.generated.ts`, `**/*.generated.tsx`, `dist`. That list is a **FLOOR, not a default value**:
   `allowedPaths` ADDS to it, so a repo that configures one of its own trees cannot silently lose the
   generated-code exemption and re-acquire this incident.
   The failure message now names `allowedPaths` as the cure for a generated file, ahead of (not
   instead of) the human-only `turnOffRuleUntilEpoch`.

**Ask 3 (`allowedPaths` vs `excludePaths`) is DEFERRED, and the ask above needs correcting on two
points:**

* **"with the other accepted as a deprecated alias" is FORBIDDEN in webpieces** — it is shim shape #1
  (two spellings of one thing) and #2 (`@deprecated` in place of deletion), and
  `backwards-compat-reviewer` rejects it. The only legal form is a HARD rename: the loader REJECTS the
  old field with an error naming the new one, via `RETIRED_CONFIG_KEYS`
  (`rules-config/src/retired-config-keys.ts`), with the read path deleted in the same change.
* **They are not one concept wearing two names.** There are only two `excludePaths` in the whole
  surface, and one of them is not the same idea at all:
  * `validate-ts-in-src.excludePaths` — a per-rule scope list. This one IS the same concept as
    `allowedPaths` and is the real rename candidate.
  * the TOP-LEVEL `excludePaths` — the ONE workspace-wide glob list every hook guard honours. It is an
    exclusion from the whole engine, not an exemption from one rule; renaming it to "allowedPaths"
    would make it read as a permission it is not.

  So the unification is one rename (`validate-ts-in-src.excludePaths` → `allowedPaths`), not a
  sweeping one.

**Sequencing it needs (why it could not ride along here).** A repo is validated by the PREVIOUS
published release, so a config key and the validator that knows it can never ship together:

1. **Source PR** — add `allowedPaths` to `ValidateTsInSrcConfig`, delete the `excludePaths` read path,
   add the `RETIRED_CONFIG_KEYS` entry whose error names the destination, migrate `defaultRules`.
2. **Publish** + bump the `catalog:` pin in `pnpm-workspace.yaml`.
3. **Config PR** — only now rename the key in this repo's live `webpieces.config.json` (and every
   consumer applies the same one-line edit the rejection message hands them).

Doing steps 1 and 3 in one PR deadlocks the session: the running validator rejects the unknown key and
blocks every Bash/Edit. That is also why **this** PR adds no key to the live `webpieces.config.json` —
`max-file-lines.allowedPaths` is optional, so nothing has to be configured for the defaults to work,
and a repo can start writing the field one release after this one ships.
