
---

## SECOND manifestation (2026-07-04): directory renames reset ALL grandfathering

Renaming `services/helper-portal-client` -> `services/helper-portal-angular` (pure `git mv`,
zero content changes) made EVERY diff-scoped rule treat all 663 files under it as NEW code:
`max-method-lines` ("NO escape possible") and `no-any-unknown` fired on the stock Fuse template
files that were grandfathered at their old paths. A pure rename (git R100) must not reset
grandfathering — the diff layer should either skip 100%-similarity renames for
NEW_AND_MODIFIED_* rules or track the file's content age, not its path age. Workaround used
(again): bump `ignoreModifiedUntilEpoch` +24h across 13 rules, which disables them for
everyone for a day. This is the same root cause as the deleted-path false positive above:
`getChangedFiles` conflates "path changed" with "code changed".
