# AI-Assisted Squash-Merge Conflict Resolution (generated)

{{RUN_STATE}}

## How the gate works

- Resolve every conflicted file in the working tree.
- Run **`pnpm {{FINISH_COMMAND}}`** — the validation + finish gate. It scans for leftover conflict
  markers, checks each conflicted file has a written merge explanation, validates, and commits the
  merge. It is the paired half of `{{START_COMMAND}}` — never finish with the other flow's command
  (`wp-start-update` pairs with `wp-finish-update`; `wp-start-upsert-pr` pairs with
  `wp-finish-upsert-pr`, which additionally runs the `nx affected` build, renders the dashboard,
  and creates/updates the PR).
- **DO `git add` each file you resolve.** Staging your resolutions is your job, not the gate's, and
  `git add` is **not** blocked by any guard. The gate stages with `git add -u`, which only re-stages
  already-tracked paths — leave a resolution unstaged and the gate stops with "Git still reports
  unmerged files" and sends you back to `git add` it.
- **Do NOT run `git commit` / `git push` / `gh pr create|edit|merge` yourself** (nor `git merge` /
  `git rebase`). The `merge-in-progress-guard` hook blocks exactly those until the gate validates.
  The gate does the commit. See `webpieces.git-workflow.md` → "Outcome B — CONFLICT merge" for the
  full who-does-what; this file does not restate it.

## STEP 1 — Load the merge context

Per conflicted file, `MERGE_DIR/updatemain-<safe_path>/` holds (`<safe_path>` = path with `/`→`__`):

```
A-forkpoint.txt   # file at fork point (base)
B-feature.txt     # file on your feature branch
C-main.txt        # file on main
B-A.diff          # what your feature changed (B−A)
C-A.diff          # what main changed (C−A)
```

`updatemain-hashes.json` holds A/B/C commit hashes. To see why main changed:
`git log <A>..<C> --oneline`.

Why A/B/C are trustworthy here — and why you must never `git merge`/`git rebase` main in yourself —
is the fork-point invariant: see `webpieces.git-workflow.md` → "THE FORK POINT INVARIANT". Read it
once if `B-A.diff` or `C-A.diff` ever shows you changes you do not recognize; that is the symptom
of a polluted fork point, not of a bad diff.

## STEP 2 — Resolve each conflicted file

For each file: read the working-tree file (the markers) and its `B-A.diff` / `C-A.diff` (intent),
then Edit to the resolved version, removing ALL conflict markers.

Strategies: goals align & non-overlapping → merge both · one side removes what the other modifies
→ prefer the removal · same lines, simple (imports/format) → merge both · same lines, complex or
conflicting goals → ask the user · feature re-implements what main already squashed → prefer
main's, then re-apply only the genuinely new feature work.

**Then write a merge explanation** for each conflicted file — NOT a comment in the source (that
breaks for JSON and deleted files). Write it next to that file's diffs, at:

```
MERGE_DIR/updatemain-<safe_path>/{{EXPLANATION_FILE}}
```

(`<safe_path>` = the conflict file path with `/` → `__`, the same dir that holds its
`A-forkpoint.txt` / `B-A.diff` / `C-A.diff`.) In it, explain in a few sentences how you resolved
this file: which side you took where, what you combined from B-A.diff vs C-A.diff, and why. The
gate fails if any conflicted file's explanation is missing or empty. Do not paste A/B/C context
blocks into the source code.

## STEP 3 — Run the gate (validates the merge AND finalizes it)

```
pnpm {{FINISH_COMMAND}}
```

- Leftover conflict markers → fix those files and re-run.
- Missing merge explanation → write it (see STEP 2) and re-run.
- Build failure → fix the TypeScript/lint errors and re-run (the gate re-stages for you).
- Missing review.json (PR flow only) → write it in the printed format (your PR review), then re-run.
- On success it commits and finalizes the merge (in the PR flow it also renders the dashboard and
  creates/updates the PR).

## Conflicted files

{{FILE_LIST}}

## If you need to bail out

A numbered backup branch was created (e.g. `<feature>PreMerge1`). To abandon:

```
git merge --abort 2>/dev/null; git checkout <feature> ; git branch -D {{SQUASH_BRANCH}}
```

Then delete `{{MERGE_DIR}}/` for a clean slate.
