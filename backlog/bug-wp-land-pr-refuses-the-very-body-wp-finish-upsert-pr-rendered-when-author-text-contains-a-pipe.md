# BUG: `wp-land-pr` refuses the very body `wp-finish-upsert-pr` just rendered, when author text contains a `|` — and the refusal prescribes a remedy that regenerates it

**Package:** `@webpieces/pr-gate`
**Files:** `src/scripts/commands/land-pr-command.js` (`notFitForGitLog`, `descriptionUnfitForGitLog`), `src/scripts/workflow/pr-merger.js`, `Dashboard.renderPrBody`
**Severity:** Medium — not data loss. It costs a full extra CI cycle per occurrence, and the error message points at the wrong cause, so the author fixes the wrong thing (or loops).

**Reported by:** a peer agent session in `acme-internal/consumer-monorepo`, which hit it twice, each time costing a full extra CI cycle. Its own diagnosis was *"`wp-land-pr` rejects any PR description containing a `|`, misreading it as a markdown table."* **That diagnosis is wrong and this ticket exists partly to correct it** — the check is deliberate and correct in intent. The defect is elsewhere.

## What the check actually is (verified in source, not inferred)

`land-pr-command.js`:

```js
notFitForGitLog(body) {
    if (body.includes('##')) return '##  (a markdown heading)';
    if (body.includes('|'))  return '|   (a markdown table)';
    return '';
}
```

Its docblock is explicit that this is **not** a heuristic:

> This reads the SAME invariant `pr-body-is-merge-body.spec.ts` asserts from the other end: the compact body "contains nothing a plain-text git log cannot carry" — no markdown heading, no table pipe. It is therefore not a heuristic about what a dashboard looks like; it is the renderer's own pinned property, checked against bytes that arrived from outside this process.

So the guard is right to exist. It stops an old-release PR — whose description is still the full `## 🚦 PR Gate Dashboard` — from dumping a risk table into `main`'s permanent history. The docblock cites a real measurement (PR #613 vs #614, 2026-08-07) and `decisions/0004 § 4.1`.

## The actual defect: the renderer can emit what the lander refuses

**`notFitForGitLog` treats `|` as proof the bytes did not come from `Dashboard.renderPrBody`. That inference does not hold.** The compact body embeds author-supplied text — the `review.json` `title` and `summary`, and risk lines. Nothing anywhere in the render path escapes, strips, or rejects a `|` in that text. I grepped `@webpieces/pr-gate/src` for pipe sanitization and there is none; `pr-merger.js` contains no `'|'` handling at all.

A `|` gets into author text for entirely ordinary reasons, none of them markdown:

- a TypeScript union in a summary — `state: 'open' | 'paused'`
- a regex alternation — `tf-mealco-api-auth|mealco-api-auth`
- a shell pipeline quoted from a repro
- an OR in prose — `location | brand scope`

So the sequence is:

1. `wp-finish-upsert-pr` renders the compact body **including the author's pipe** and posts it. It reports success.
2. `wp-land-pr` reads that same description back, sees `|`, and concludes it is not the gated body.
3. **The two commands in one flow disagree about what the renderer produces.**

## The refusal then misdiagnoses it, and its remedy loops

`descriptionUnfitForGitLog` says:

> The usual cause is a PR posted by a webpieces release OLDER than the one that made the description the commit body. The dashboard now lives in the PR's 1st comment instead.
>
> Re-run finish — it re-renders the description in the compact form and re-posts it to this same PR, then landing works:
> `pnpm wp-start-upsert-pr && pnpm wp-review-upsert-pr && pnpm wp-finish-upsert-pr`

When the pipe came from author text, that prescription is wrong twice over. The cause is not an old release. And re-running finish **re-renders the identical pipe from the unchanged `review.json`**, so landing fails again — an infinite loop until the author independently guesses that a character in their prose is the problem. Re-running that chain is what makes this cost a CI cycle rather than a minute.

Note the guard also fires on `##`, which reaches author text just as easily (a markdown heading inside a `summary`). Same defect, same loop.

## Why the peer's workaround is bad guidance

The peer concluded: *"Keep pipes out of the PR body entirely — no tables, no regex alternations, no TypeScript union types. Write prose."* That is a real constraint nobody can discover from the error message, and it silently degrades review quality — a union type or a regex is often the most precise way to state a risk. Agents and humans should not have to avoid a character because of a downstream invariant check.

## Suggested fixes, cheapest first

1. **Make the renderer own the invariant.** Since the property being asserted is "`renderPrBody` never emits `##` or `|`", have `renderPrBody` guarantee it — escape or substitute those characters in interpolated author text (`|` → `¦` or `\|`; `##` → `#`). Then the lander's check keeps its exact meaning and stops firing on legitimate content.
2. **Fail at finish, not at land.** If substitution is unwanted, have `wp-finish-upsert-pr` refuse *before posting*, naming the offending field and character. The author fixes `review.json` once, in the same run, with no extra CI cycle.
3. **Fix the refusal message either way.** It should name the offending character AND state the second possible cause — author text — rather than asserting an old release as "the usual cause". As written it sends the reader down a version-skew path that does not exist.

## What I could not verify

I read the installed `@webpieces/pr-gate` (`land-pr-command.js`, `pr-merger.js`) and confirmed the check and the absence of sanitization. I did **not** reproduce the failure end to end — the peer's two occurrences are the observed evidence, and the mechanism above is reconstructed from source. If `Dashboard.renderPrBody` does escape pipes somewhere I did not find, this report reduces to fix 3 alone (the misleading message), which still stands on its own.
