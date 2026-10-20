# webpieces.config.json — how upgrades work (read this before you edit the file)

> Written by `wp-install-ai-hooks`. Do not hand-edit; edit the template in `@webpieces/rules-config`.

## The one rule

**webpieces.config.json is never released backwards-compatible.** When a config key moves, is renamed,
or is removed, the loader **rejects** the old shape and hands you an error naming the destination:

```
[commands] "upsertPr" is a RETIRED webpieces.config.json key. It moved to
"commands.guardHints.prCreationOrPush". Move the value to "guardHints": { "prCreationOrPush": <value> }
inside the same "commands" section, then delete "upsertPr".
```

That error IS the migration. Apply the edit it describes and re-run your command.

## Why it works this way

Every reader of this file is a coding agent. The config is validated on startup, you are handed the exact
edit, and you apply it in one pass — so upgrades are seamless **without** webpieces shipping a
compatibility layer for every old shape.

The alternative — quietly accepting both shapes — is worse than it looks. Two accepted shapes mean two code
paths, two sets of defaults and two sets of error messages to keep honest forever. Worse, an accepted shape
is **never migrated**: nothing ever forces the edit, so the dead shape lives in the config indefinitely and
the compatibility code can never be deleted.

## You cannot get stuck

A rejected config is always repairable from inside the failure:

- **Editing `webpieces.config.json` is always allowed**, even while the config is invalid.
- **`pnpm install` is always allowed** (installer bypass).

## What to do when the config fails to load

**Edit `webpieces.config.json` and apply every error literally. That is the whole procedure.** Each error
names the exact change to make, and editing this file is always allowed — including right now, while it is
invalid.

- **An UNKNOWN key: delete it.** A key the running validator has no schema for controls nothing — every
  code path that would read it is keyed off that schema — so leaving it is dead config that reads as live
  config to the next reader. When the key is RETIRED, deleting it is the *whole* fix.
  `pnpm wp-prune-unknown-config` strips every unknown key for you, and it is on the guard's cure allowlist,
  so it runs even while the invalid config is blocking everything else.
- **A RETIRED key with a destination: apply the move.** A rename carries its value over, so delete-and-move
  on is wrong there — the error tells you which case you are in.
- **A MACHINE-LOCAL setting does not belong in this file.** Those live in `~/.webpieces/config.json` under
  `experimental` — an optional file tracked by no repo, whose absence is the default behaviour.

**Do NOT run `pnpm install` for a validation error.** It cannot help: the guards only run once package.json
and node_modules already agree, so there is nothing out of date to install.

The one case that *is* a stale install — your pinned `@webpieces` being a release BEHIND this config, so the
running validator does not recognise a legitimately newer key — never reaches this banner. The
version-drift guard compares the pin against the installed version *before* the validator runs, and denies
every tool call with its own message and its own cure. So if you are reading a validation error, no drift
was detected.

## Documentation lives outside JSON

The first entry in `webpieces.config.json` must be exactly:

```json
"webpiecesConfigJsonDocumentation": ".webpieces/instruct-ai/webpieces.config-policy.md"
```

This path is required and validated literally. The loader regenerates this guide before validating the
config, including when validation fails, so the link has a real destination on a fresh checkout.
`wp-install-ai-hooks` also writes it. Do not hand-edit the generated guide.

Inline `*Why` keys, including `upgradePolicyWhy`, are rejected at every config section.
Remove them from JSON. Keep repository-specific decisions in tracked Markdown in the repository;
put reusable config instructions in this guide's source template. Generated files are overwritten.

## Merge automation and existing authorization

`commands.pr-gate.mergeMode` controls only what `wp-finish-upsert-pr` does:

- `AUTO`: attempt to squash-merge; if necessary and available, queue GitHub auto-merge.
- `NONE`: publish/update the PR without attempting to merge it.

This setting does not require extra merge authorization and does not override user instructions.
When the user has requested landing, including through `$full-cycle` or `/full-cycle`, continue with
`pnpm wp-land-pr` after the required checks. That command works with either value. GitHub permissions
and merge requirements still apply. See `webpieces.git-workflow.md` for the workflow.
