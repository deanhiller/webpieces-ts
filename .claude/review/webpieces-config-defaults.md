# Checklist: a RULE must not have a DEFAULT — the consumer decides, explicitly

**The policy, in one sentence:** every webpieces rule with a schema is one the consumer's
`webpieces.config.json` must carry an entry for, and no code path anywhere may supply a value that
makes an unconfigured rule run — **unless the value is INERT**, in the sense defined below.

This is the checklist for `webpieces-config-defaults-reviewer`, a REQUIRED reviewer over every PR that
touches `packages/tooling/rules-config/**` or `webpieces.config.json`. A 🔴 verdict BLOCKS the PR. The
binding rule is `.claude/rules/no-rule-defaults.md`; this doc is how you enforce it against a diff.

There is no new agent behind this id. `commands.pr-gate.checklists` entries name a **doc**, and the
one generic `webpieces-reviewer` agent reviews whichever doc the gate hands it — which is why this
checklist could be registered in the same PR that wrote it.

## Why a default is a defect here, when everywhere else it is a convenience

A default is normally a kindness: it saves the caller a decision that has an obvious answer. That
argument fails for this framework, and the reason is *who the caller is*.

A webpieces rule does not compute a value. It **governs a repository** — it decides whether a branch
name is refused, whether merged branches are DELETED with nobody watching, how far behind `main` a
tree may be before every Read is blocked, whether a contract scan runs at all. Those are not obvious;
they are policy, and they belong to the team that owns the repo. A default for them is not a kindness,
it is one framework author answering, invisibly, a question that was never put to the several hundred
repos that inherit it. Dean, filing #1017:

> you don't decide shipping off or on. In fact you just require the new `webpieces.config.json` every
> time and clients decide OFF or on!!!!! ... otherwise it never triggers upstream agents to turn it on
> and it gets missed.

The last clause is the mechanism. **A failing config load is the delivery mechanism**, exactly as a
compile error is for a changed surface (`.claude/rules/no-backwards-compat.md`): the upgrade breaks,
the agent reads "add this entry, here is the snippet, choose a value", finds out what the rule does,
and a human decides. A default produces the opposite — the rule arrives silently, nobody is asked,
nobody reads it, and an accepted shape is never migrated.

**It cannot wedge anybody**, which is what makes the hard failure safe: editing `webpieces.config.json`
is always permitted, even while the config is invalid, and the validator prints a copy-paste entry per
missing rule.

## The ONE legitimate default, and the line it draws

`commands.pr-gate.reviewerAgentName` defaults to `webpieces-reviewer`. That default **stays**, and it
is the cleanest statement of the boundary you are enforcing:

| | the six #1017 deleted | `reviewerAgentName` |
|---|---|---|
| what it selects | whether a rule runs; which branch names are refused; whether branches are deleted | which of webpieces' own agent files is spawned |
| who it belongs to | the consuming repo's team | webpieces |
| what a consumer sees if it changes | branches start (or stop) disappearing | nothing |

So the test is **not** "is there a default?" — it is **"does this default decide something the
CONSUMER owns?"** A default that picks an internal implementation is inert and fine. A default that
makes a consumer's policy decision for them is the defect. The config's own `reviewerAgentsWhy` makes
the same point from the other side: naming that default explicitly, with no `overrideReviewerAgent`
beside it, is *rejected* as "a key that looks meaningful but controls nothing".

Do not go 🔴 on an inert default, and say in your verdict why you judged it inert. A reviewer that
fires on correct code gets argued past, and after that the real findings get argued past too.

## The six shapes that are an automatic 🔴

**1. A new rule SCHEMA with no matching demand.** A new entry in `RULE_SCHEMAS`
(`packages/tooling/rules-config/src/rule-schemas.ts`) is what makes the config demand an entry. If a
diff adds a rule and its schema, that is correct and expected — go 🔴 only if the diff ALSO gives the
rule a `defaultRules` entry that would let it run unconfigured. Grep:
`git diff <base> -- packages/tooling/rules-config/src/rule-schemas.ts packages/tooling/rules-config/src/default-rules.ts`

**2. A `defaultRules` entry carrying `mode`.** `mode` is the on/off switch. A default for it is the
whole defect, in its purest form. `no-rule-defaults.spec.ts` asserts this, so a diff that reintroduces
one has to have edited that spec too — see shape 6.

**3. A `defaultRules` entry carrying a schema-REQUIRED field.** Same argument one level down:
`autoReapMergedBranches`, `subBranchNaming`, `maxCommitsBehind` are BEHAVIOUR, and behaviour is
stated. Check each field the diff adds to `defaultRules` against that rule's `SCHEMA`: if the
`FieldDef` is not `FieldDef.optional(...)`, it is a 🔴.

**4. A required field DOWNGRADED to optional so a default can live somewhere else.** Watch for
`new FieldDef('boolean')` → `FieldDef.optional('boolean')` in `rule-configs.ts` /
`main-sync-guard-configs.ts` / any `*-config.ts`, especially beside a new `??` fallback in the rule's
own code. That is the same default, relocated. The cure is the opposite move: make it required and
delete the `??`.

**5. A `??` / `||` / `?.` fallback in a rule's read path.**
`this.config.subBranchNaming ?? DEFAULT_SUB_BRANCH_NAMING` was the live instance #1017 deleted.
A rule reading a schema-required field reads it directly — a config that reached the rule passed
validation, so absence at runtime means validation was bypassed, and inventing a value there hides
that rather than surviving it. Grep the diff for `?? DEFAULT_`, `?? true`, `?? false`, `?? 5`.

**6. The enforcement weakened instead of the defect fixed.** A diff that edits
`packages/tooling/rules-config/src/no-rule-defaults.spec.ts` to permit what it used to forbid, or
removes a rule from the list it checks, or deletes the spec — and does not, in the same diff, delete
the default that made the spec red. Read the spec change FIRST when both appear.

## What is explicitly NOT in scope

- **Optional-field tuning values in `defaultRules`** — `max-file-lines.limit: 900`,
  `no-destructure.allowTopLevel: true`, `validate-ts-in-src.excludePaths`. The rule RUNS either way;
  these tune how loudly. That is what `defaultRules` is *for* now, and the file says so.
- **`SEED_VALUES` in `seed-entry.ts`.** A seed value is written INTO the consumer's own config file,
  where they read it, review it and change it like any other line they own. That is the opposite of
  invisible. Check only that a seeded value is conservative where the setting is destructive —
  `autoReapMergedBranches` seeds `false`, because "nobody has answered yet" must mean "delete no
  branches".
- **The `experimental.*` flags in `~/.webpieces/config.json`.** Those ship OFF and stay OFF by a
  different policy, enforced by `experiment-lifecycle-reviewer`. Do not duplicate its verdict, and do
  not demand a `webpieces.config.json` entry for a machine-local flag — `whole-repo-build-guard` is
  deliberately absent from `RULE_SCHEMAS` for exactly that reason, and putting it back is its own,
  separate defect (fault Y: every Bash call blocked on upgrade).
- **A default INSIDE a consumer's own repo config.** You review webpieces' source, not the values
  this repo chose.

## The GREEN path

A diff passes when, for every rule it adds or changes:

1. the rule has a `RULE_SCHEMAS` entry, so the config DEMANDS one — check by reading the diff, not by
   assuming;
2. `defaultRules` carries no `mode` and no schema-required field for it;
3. every field that changes BEHAVIOUR is schema-required, and the rule reads it with no `??`;
4. `packages/tooling/rules-config/src/no-rule-defaults.spec.ts` is unweakened;
5. any default it DOES add is inert by the table above, and the diff says which.

## Your verdict

Name the file, the rule, the field, and the deletion that should have replaced it. If you are 🔴 on
shape 4 or 5, say which field to make required and which `??` to delete — that is a one-line fix and
the author should not have to work it out from a principle.
