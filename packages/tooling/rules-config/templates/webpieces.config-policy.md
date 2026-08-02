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

Do these in order. **Do not start by deleting keys** — that usually deletes valid config.

1. **`pnpm install`.** This is the most common cause by far: your installed `@webpieces` validator is a
   release BEHIND this config (a dep bump updated the config and lockfile, but `node_modules` was never
   re-installed), so the running validator does not recognise a legitimately newer key. Installing syncs
   them.
2. **Re-run your command.** If the errors are gone you are done — do not touch the config file.
3. **Only if an error survives a fresh install** is it a genuine retired / renamed / typo'd key. Now edit
   `webpieces.config.json`, applying each error's instruction literally.

## Documenting your own config: the `*Why` convention

JSON has no comments, so any key ending in **`Why`** is free-form rationale kept beside the key it explains,
and must be a string:

```json
"mergeModeWhy": "NONE, deliberately: a human always clicks merge in this repo.",
"mergeMode": "NONE"
```

Unknown keys are rejected — a silently-ignored key is how a stale config survives an upgrade — so if you
want a note in the file, give it a `*Why` name rather than inventing a key.

One exception: **`gateSaltWhy` is rejected outright.** Rationale next to the gate salt necessarily explains
what the token protects and that the salt is committed, i.e. it is a bypass how-to sitting in the most-read
file in the repo. That reasoning lives in the webpieces source instead.
