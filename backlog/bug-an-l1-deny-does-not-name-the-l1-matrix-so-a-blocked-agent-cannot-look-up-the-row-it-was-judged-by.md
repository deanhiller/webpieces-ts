# BUG: an L1 deny does not name the L1 matrix, so a blocked agent cannot look up the row it was judged by

## Symptom

L1 stamps `layer=L1 row=<n>` on every decision it makes. A fleet audit counted **1,457** such decisions
across nine repos, with rows 0, 1, 4, 5, 6 and 7 all in active use — and there was nowhere to look a row
up. PR #696 fixed the record half of that: it shipped `webpieces.location-matrix.md`, the delivered copy
of L1's row table (with a `cure` column and a "How a log line joins to a row" section), byte-locked to
`renderL1Doc()`.

It did not fix the experience, and its author flagged exactly that as the remaining gap. **Nothing pointed
an agent at the file.** An agent told `layer=L1 row=6` at the moment it is blocked still had no path to
the table:

- `guards/L1-location.md` is a path in *webpieces' own repo*; a consumer repo has no such directory.
- The delivered copy now always exists, but its location (`<root>/.webpieces/instruct-ai/`) is not
  something the deny mentions, and the shell's cwd is not the governed root — so even guessing a relative
  path is unusable.

L0 (`guardMatrixPointer`) and L2 (`branchStateMatrixPointer`) have both named their matrix, by absolute
path and by row, in the deny text for releases. L1 — the layer emitting by far the most `row=` — was the
only one that did not.

## Why this matters AT DENY-TIME specifically

The doc only helps at the moment of the deny. A blocked agent reads exactly one thing: the deny text.
Everything else — the log line it just wrote, the table sitting on disk, the guard source — is a file it
has no reason to open and no name for. So a table that is not named in the deny is, from the agent's side,
indistinguishable from a table that does not exist. Shipping the doc without the pointer fixes the record
but not the experience, which is the difference this closes.

The row number is the load-bearing part, not the path. A bare "read this doc" is a page; a row number is
the two lines that explain *this* verdict — and it is the same number the L1-decisions log line already
carries, so the deny and the trail join.

## The fix

L0's mechanism, applied to L1 — the same three pieces `l2-matrix-doc.ts` documents in full:

- **the DOC** — `LOCATION_MATRIX_DOC` (`webpieces.location-matrix.md`), already shipped by #696 and
  byte-locked to `renderL1Doc()` by `l1-matrix.spec.ts`. Unchanged.
- **the WRITE** — `writeLocationMatrixDoc()`: lazy and best-effort, **only on a block**. An agent that was
  never blocked never pays for a file it will not read, and a failed write costs the reader a pointer
  rather than turning their deny into a stack trace.
- **the POINTER** — `locationMatrixPointer(docPath, row)`: an ABSOLUTE path, opening with a NEWLINE and
  carrying no quotes or backslashes. Absolute because the shell's cwd is not the governed root; on its own
  line because the deny renders in the house format (header, `[guard-name]` block, `Fix Option N:` lines)
  and a pointer glued onto the last line is the one place that shape breaks; quote-free because the text is
  interpolated into a JSON decision payload, where a quote corrupts the decision rather than merely the prose.

It is appended in **one** place — `withL1MatrixPointer`, wrapping every branch of `runner.l1LocationBlock`,
which is the single scope every L1 deny funnels through and the same scope that already logs `row=`. So the
pointer and the log line cannot name different rows, no future L1 block path can silently skip it, and the
three report builders keep owning their own deny prose (no three near-identical stanzas to drift).

That includes the **row-0 pre-stage** (`misplacedCdBlock`), which decides from command text before a tree is
resolved. It is the deny path most easily left out of a centralised pointer, and row 0 exists in the
delivered table precisely so the pointer can name it.

## Regression cover

`l1-matrix.spec.ts` carries both halves, next to the byte-lock they belong with. The unit-level pointer
assertions mirror L2's; and a new end-to-end describe drives the REAL runner through `runBash`, asserting an
L1 deny contains the ABSOLUTE matrix path and the ROW it was judged by — for row 0 (the pre-stage) and row 5
(a tree-based row, reached through `firstMatchingL1Row`), i.e. both branches of `l1LocationBlock`. It also
pins that the doc is written only on a block, and that the delivered text adds nothing that could corrupt
the JSON payload.
