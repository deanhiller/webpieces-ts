# AI-Assisted Squash-Merge Conflict Resolution

You are resolving merge conflicts from the 3-point squash-merge workflow. `pnpm wp-upsert-pr`
(or `pnpm wp-git-update`) attempted to squash-merge your feature branch onto the latest main,
hit conflicts, wrote the 3-point context, and **handed control back to you**.

You are currently on the `…Squash` branch with conflict markers in the working tree.

## How the gate works (important)

- You resolve every conflicted file in the working tree.
- You then run **`pnpm wp-git-merge-complete`**. That command is the validation gate: it
  scans the resolved files for leftover conflict markers, runs the `nx affected` build, and —
  only if both pass — stages and commits the merge and unblocks the workflow.
- **Do NOT run `git add` / `git commit` / `git push` / `gh pr` yourself.** They are blocked by
  the `merge-in-progress-guard` hook until the gate validates. The gate does the commit.
- After the gate succeeds, run `pnpm wp-upsert-pr` (or `pnpm wp-git-update`) to finalize & push.

## STEP 1 — Load the merge context

The handback message printed the merge directory, e.g.
`MERGE_DIR = <repoRoot>/webpiecesTmp/merge-<feature>` (feature = branch name, `/`→`-`, `Squash`
suffix stripped). In it:

```
updatemain-hashes.json              # A=hashForkPoint, B=hashFeatureHead, C=hashMainHead
updatemain-conflicted-files.txt     # the conflicted files, one per line
updatemain-<safe_path>/A-forkpoint.txt   # file at fork point (base)
updatemain-<safe_path>/B-feature.txt     # file on your feature branch
updatemain-<safe_path>/C-main.txt        # file on main
updatemain-<safe_path>/B-A.diff          # what your feature changed (B−A)
updatemain-<safe_path>/C-A.diff          # what main changed (C−A)
```

`<safe_path>` = file path with `/` replaced by `__` (e.g. `src/api/x.ts` → `src__api__x.ts`).

Read `updatemain-conflicted-files.txt`, and to understand WHY main changed, run
`git log <A>..<C> --oneline` (A/C from `updatemain-hashes.json`).

## STEP 2 — Resolve each conflicted file

For each file: read the working-tree file (to see the markers) and its `B-A.diff` / `C-A.diff`
(to see intent). Then Edit the file to the resolved version, removing ALL conflict markers.

Resolution strategies:

- **Goals align, non-overlapping** → merge both changes.
- **One side removes what the other modifies** → prefer the removal.
- **Same lines, simple (imports/format)** → merge both intelligently.
- **Same lines, complex business logic, or directly conflicting goals** → ask the user, with
  both goals explained. Don't guess.
- **Feature re-implements what main already squashed** → prefer main's version, then apply only
  the genuinely new feature work on top.

Do not leave any `A/B/C` context comment blocks pasted into the code — the gate's marker scan
will reject leftover markers, and stray context blocks pollute the diff.

## STEP 3 — Run the gate

When every conflicted file is resolved:

```
pnpm wp-git-merge-complete
```

- If it reports **leftover conflict markers** → fix those files and re-run it.
- If it reports a **build failure** → fix the TypeScript/lint errors and re-run it (no need to
  re-stage; the gate stages for you).
- On success it commits the merge and prints the finalize instruction.

## STEP 4 — Finalize

```
pnpm wp-upsert-pr      # (or pnpm wp-git-update)
```

This force-pushes the resolved squash branch over your feature branch and updates/creates the PR.

## If you need to bail out

A backup branch was created (e.g. `<feature>Backup1`). To abandon the in-progress merge:

```
git merge --abort 2>/dev/null; git checkout <feature> ; git branch -D <feature>Squash
```

Then delete the marker dir `webpiecesTmp/merge-<feature>/` if you want a fully clean slate.
