# FEATURE: rename `gateSalt` to a less self-announcing config key

**Package:** `@webpieces/rules-config` (schema owner) + `@webpieces/pr-gate` (consumer)
**Severity:** Low — nothing is broken. This raises the floor on *incidental* discovery only.

Split out of "collapse the PR gate to ONE required check — write the PR body BEFORE the push", which
was implemented without it so that release carried exactly one consumer-facing migration (repointing
branch protection at the Actions job). This is the leftover.

## The ask

Consumer, verbatim: *"we could even misname it in `webpieces.config.json` to help."*

`prGate.gateSalt` is a self-announcing name. An agent asked to "make this PR pass" that greps the
config finds it immediately. A neutral name (`prGate.buildFingerprintKey`, say) does not stop anyone
who reads the webpieces source — the whole mechanism is obscurity-grade, since the salt is committed
— but it does stop the realistic case, which is incidental discovery by an agent or teammate who is
not hunting for a bypass.

## Why the consumer cannot do this themselves

webpieces owns the schema key, and an unknown field is a hard config error
(`[pr-gate] Unknown field "…"`). So it is only actionable upstream.

## What it costs

A **breaking config rename**. Every consumer repo must edit `webpieces.config.json` in lockstep with
the upgrade, so it needs the same treatment #487's checklist-manifest rename got: a migration note,
and ideally a validator error that names the OLD key and says what to rename it to rather than the
generic "Unknown field".

## Source

- `packages/tooling/rules-config/src/pr-gate-config.ts` — schema
- `packages/tooling/rules-config/src/validate-config.ts` — the unknown-field error to special-case
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts`,
  `check-pr-command.ts` — the two readers
- `packages/tooling/rules-config/templates/webpieces-pr-gate.yml` — the TO ENABLE instructions name it
