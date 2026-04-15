# @webpieces/config

Shared loader for `webpieces.config.json` — the single source of truth for
validation rule configuration in a webpieces workspace.

Two consumers share this package:

- **`@webpieces/ai-hooks`** — write-time validation (Claude Code PreToolUse,
  openclaw `before_tool_call`). Reads `enabled` + rule options.
- **`@webpieces/architecture-validators`** — Nx `validate-code` /
  `validate-ts-in-src` executors. Reads `enabled`, `mode`, `disableAllowed`,
  `ignoreModifiedUntilEpoch`, plus rule-specific options.

Flipping `"enabled": false` on a rule in `webpieces.config.json` turns it off
in **both** systems. That is the whole point.

## File format

```json
{
    "rules": {
        "no-any-unknown": {
            "enabled": true,
            "mode": "MODIFIED_CODE",
            "disableAllowed": true
        },
        "max-file-lines": {
            "enabled": true,
            "mode": "MODIFIED_FILES",
            "limit": 900
        }
    },
    "rulesDir": []
}
```

Rule names are **kebab-case**. Unknown option keys are preserved so a
consumer that understands them can read them; consumers that don't, ignore
them.
