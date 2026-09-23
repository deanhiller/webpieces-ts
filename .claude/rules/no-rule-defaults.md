# A RULE MUST NOT HAVE A DEFAULT — the consumer decides, explicitly

Read this when your diff adds or changes a webpieces RULE: a `RULE_SCHEMAS` entry, a `defaultRules`
entry, a `FieldDef`'s optionality, or the code path that reads a rule's config.

## The rule

**Every rule with a schema is one `webpieces.config.json` must carry an entry for. No code path may
supply a value that lets an unconfigured rule RUN.** Not `mode`, not a schema-required field, not a
`??` fallback in the rule's own read path. A missing entry FAILS THE CONFIG LOAD, naming the rule and
printing the entry to paste.

That failure is not a rough edge; it is the **delivery mechanism**, the same one
`.claude/rules/no-backwards-compat.md` relies on for a changed surface. The upgrade breaks, the agent
reads "add this entry", finds out what the rule does, and a human chooses. A default produces the
opposite: the rule arrives silently, nobody is asked, and — in Dean's words filing #1017 — *"it never
triggers upstream agents to turn it on and it gets missed."*

A hard rejection cannot wedge anybody: editing `webpieces.config.json` is always permitted, even while
the config is invalid, and the validator prints a copy-paste entry per missing rule.

## The measurement behind it

41 rule schemas, 35 config entries, and SIX rules running on a value no consumer was ever shown:

| rule | the default nobody chose |
|---|---|
| `branch-creation-guard` | `mode:'ON'`, `subBranchNaming:'feature/<ticket>/<short-description>'`, **`autoReapMergedBranches:true`** |
| `pr-lifecycle-guard` | `mode:'ON'` |
| `branch-state-guard` | `mode:'ON'`, `maxCommitsBehind:5` |
| `no-root-union-api-type` | `mode:'RUN_EVERY_TIME'` |
| `api-rules-for-openapi` | `mode:'OFF'` |
| `api-rules-for-mcp` | `mode:'OFF'` |

The top three are the strongest case, because they are BEHAVIOUR rather than lint volume: every
consuming repo was running a branch-naming convention, a commits-behind ceiling, and **automatic
deletion of merged branches**, on values nobody there could see without reading webpieces' source.

## Where the line is: a default that is INERT is fine

`commands.pr-gate.reviewerAgentName` defaults to `webpieces-reviewer`, and that default stays. It
selects one of webpieces' OWN agent files; no consumer behaviour changes, and nothing about their repo
is decided. The test is therefore not "is there a default?" but **"does this default decide something
the CONSUMER owns?"** — whether a rule runs, which names are refused, what gets deleted.

`defaultRules` survives for exactly one job: the value an **optional** field takes when a consumer
omits it (`max-file-lines.limit: 900`). The rule runs either way; the knob tunes how loudly.

`SEED_VALUES` (`seed-entry.ts`) is also not a default. A seed value is written INTO the consumer's own
file, where it is read and reviewed like any line they own — which is the opposite of invisible. It is
conservative where the setting is destructive: `autoReapMergedBranches` seeds `false`, because "nobody
has answered yet" must mean "delete no branches".

## Decided for `branch-creation-guard`'s non-`mode` fields (#1017)

- `subBranchNaming` — **REQUIRED.** It decides which branch names the guard BLOCKS, and the refusal
  quotes it back as the convention to follow. Behaviour.
- `autoReapMergedBranches` — **REQUIRED** (it already was). It deletes branches unattended.
- `maxLocalBranches`, `maxWorktrees` — **optional knobs.** They tune a refusal that PRINTS the cap it
  hit, so the value is visible at the moment it bites rather than only in webpieces' source.

## Enforcement

- `packages/tooling/rules-config/src/no-rule-defaults.spec.ts` — asserts `defaultRules` carries no
  `mode` and no schema-required field, and that EVERY schema'd rule is demanded of the config.
- `webpieces-config-defaults-reviewer` — REGISTERED in `commands.pr-gate.checklists` and REQUIRED over
  `packages/tooling/rules-config/**` and `webpieces.config.json`. Its checklist,
  `.claude/review/webpieces-config-defaults.md`, lists the six shapes that are an automatic 🔴 —
  including the one a spec cannot catch: weakening the spec instead of deleting the default.

There is no new agent file. A `checklists` entry names a **doc**, and the one generic
`webpieces-reviewer` reviews whichever doc the gate hands it.
