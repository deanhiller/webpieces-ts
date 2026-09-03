# 0005 — The PR description IS the merge body, so there is no machine-global store

**Status:** taken and implemented
**Supersedes:** [0004](0004-pr-artifacts-are-machine-global.md) (which is now marked SUPERSEDED)
**Measured:** 2026-08-07, macOS (darwin 25.3.0), git 2.x, `gh` 2.x
**Retires:** `~/.webpieces` — webpieces now writes state ONLY under `{repo}/.webpieces`
**Where:** `packages/tooling/pr-gate/src/scripts/commands/land-pr-command.ts`,
`packages/tooling/pr-gate/src/scripts/workflow/merge-body-temp-file.ts`,
`packages/tooling/pr-gate/src/scripts/workflow/cleanTmp.ts`,
`packages/tooling/rules-config/src/index.ts`

---

## 1. The premise 0004 rested on stopped being true

0004 moved the gated squash-commit body out of the rendering worktree and into
`~/.webpieces/prs/<host>/<owner>/<repo>/<n>/merge-commit-body.md`, so `wp-land-pr` could find it from
any tree. Its § 4.1 explains why landing must never reach for the PR description instead:

> In a real consuming repo the PR description IS the full PR Gate Dashboard, and GitHub's default
> `squash_merge_commit_message=PR_BODY` dumping that dashboard into the commit is precisely the ugly git
> log this whole mechanism exists to prevent.

**PR #611 (commit `884a384`) inverted exactly that**, the same day. It swapped the two surfaces: the PR
DESCRIPTION became the compact risk/flags/link string, and the full dashboard moved into the PR's 1st
comment (the reviewer checklist is the 2nd). `pr-body-is-merge-body.spec.ts` pins the result — there is
ONE renderer, `Dashboard.renderPrBody`, and `finish-upsert-pr-command.ts` uses its output as *both* the
PR description and the `--body-file` it merges with.

#611 touched 25 files and touched neither `land-pr-command.ts` nor `pr-body-store.ts`. So the store
survived — not as the only home for the bytes, but as **a local cache of a fact GitHub now holds
authoritatively.** A cache with three failure modes (missing, stale, on the wrong computer) and no
upside, since the authoritative copy is one `gh` call away and the *whole point* of #611 is that those
bytes are fit for a squash commit.

**Verification, re-run before deleting anything:**

```bash
git show 884a384 --stat                  # 25 files; no land-pr-command.ts, no pr-body-store.ts
gh pr view <n> --json body               # returns exactly renderPrBody(...) + the gate token
```

## 1a. And the key was never stable — the store was broken as well as redundant

0004's § 3 layout is written as `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/`. **The first segment is not
a host.** It is the host-position token of whatever string `origin` happens to be spelled as, sanitised:
`pr-body-store.ts` parsed the remote (`parseRemote`, scp-form regex), took `parts.host` through `safe()`,
and made it segment 0 via `RepoSlug.segments()`. Nothing normalised it.

Measured on this machine, 2026-08-07 — both of these are github.com:

```
$ git -C <this repo> remote get-url origin
personal:deanhiller/webpieces-ts.git          # "personal" is an ~/.ssh/config Host ALIAS

$ find ~/.webpieces/prs -maxdepth 3 -type d
~/.webpieces/prs/personal/deanhiller/webpieces-ts
~/.webpieces/prs/github.com/acme-internal/consumer-monorepo
```

So two clones of ONE repo whose `origin` is spelled differently — ssh alias vs full host, ssh vs https,
with or without a trailing `.git` — key to different directories. `wp-finish-upsert-pr` files the
receipt under one, `wp-land-pr` in the other clone looks under the other, finds nothing, and prints
"PR #N was not found on this machine": **a re-run of the exact cross-tree failure 0004 was written to
fix**, one level out. A plain `git remote set-url` silently orphans every receipt already filed, with no
error and no signpost.

**Why the answer is deletion and not "normalise the URL".** Normalising is a guessing game with no
ground truth available locally: an ssh alias resolves only through the user's `~/.ssh/config` (which may
itself `Include`, use `Match`, or point at a bastion), and ssh-vs-https, case, ports, credentials-in-URL
and `.git` suffixes all have to be folded without ever folding two DISTINCT repos together — the failure
0004 § 3 correctly refused to risk. Reading the body from the PR removes the question instead of
answering it: **the PR is already the canonical identity, so there is nothing left to key.** `gh` itself
resolves the remote, including the alias, and it is the only component that can.

To be precise about what is being retired: 0004's **rule** — *key an artifact by the scope of the fact
it describes* — is sound and survives; it is why the body lives on the PR now rather than in a tree. Its
**implementation** keyed by a string SPELLING of the remote rather than by the remote's identity, which
is a narrower key than the fact and drifts under a `set-url`. The mechanism is retired, not the
principle.

## 2. What replaces it

`wp-land-pr` reads the PR once — `gh pr view <branch> --json number,title,url,body,headRefOid` — and
writes `body` to a temp file for `--body-file`. CRLF is normalized to LF, because GitHub stores
descriptions with CRLF and a commit message must not carry them.

**The invariant is unchanged: THE BYTES THAT LAND ARE THE BYTES FINISH PRODUCED.** What changed is who
is holding them. Landing still never re-renders the body — that would be a second authoritative gate
whose result nobody reads.

What this buys, beyond deleting a directory:

| before | after |
|---|---|
| land only from the machine that posted the PR | land from any machine, any clone, a fresh clone |
| a "not found on this machine" refusal with a human opt-in attached | one refusal (empty description), one cure (re-run finish) |
| a receipt that ages out after 30 days | GitHub keeps the description as long as the PR exists |

## 2a. Measured end-to-end, and the ONE transition hazard it exposed

The premise was checked against real PRs on this repo, not just against the renderer:

```
$ gh pr view 613 --json body -q .body > body.txt        # posted AFTER the swap
$ git log -1 --format=%b 1c0c252 > commit.txt           # its squash commit
$ diff body.txt commit.txt
13,14d12
<
<
```

**Byte-identical apart from two trailing blank lines**, which git strips from a commit message anyway
— and which landing normalises explicitly (`body.trim() + '\n'`). That is the premise confirmed on live
data.

The same measurement exposed a hazard the source reading alone would have missed. **A PR posted by a
release OLDER than the swap still has the FULL DASHBOARD as its description.** PR #611 itself is the
clearest case: its description is `## 🚦 PR Gate Dashboard …` while its squash body is the compact form,
because it was POSTED by the old release and MERGED by the new `--body-file`. And it is not only
history: PR #614 was still open at the time of writing, created four minutes before the 0.4.596 upgrade
landed, with a dashboard description. Landing that PR with the new command would put a risk table into
main permanently — precisely the defect 0004 § 4.1 warned about.

So landing REFUSES a description that is not a compact body, naming the marker it found and the one
command that fixes it (`wp-finish-upsert-pr` re-renders and re-posts the description to the same PR).

The check is **not** a heuristic about what a dashboard looks like, and it is **not** a compatibility
fallback — it never rewrites the bytes and never reaches for a second source. It reads the property
`pr-body-is-merge-body.spec.ts` already pins on the renderer — *"contains nothing a plain-text git log
cannot carry"*, i.e. no `##` and no `|` — from the other end, against bytes that arrived from outside
the process. It keeps earning its place long after the transition, because nothing stops a human editing
a PR description in GitHub's textarea and this is the only point between that edit and main's history.

## 3. `--fallback-title-only` is DELETED, not kept

The flag existed for exactly one situation, stated in its own help text: *the gated body is not on this
machine.* That situation is now unreachable — the body is wherever the PR is — so per
`.claude/rules/no-backwards-compat.md` the flag is deleted rather than left as a
never-taken branch. Gone with it: `LandPrOptions`, `fallbackBody`, `writeFallbackBody`,
`fallbackNotice`, `notOnThisMachine`, and `legacySignpost`. `LandPrCommand.run()` is nullary and
`wp-land-pr` declares no flags at all.

0004 § 4.1's reasoning was *right for its time* and is preserved above rather than quietly reversed:
"never put the PR description in a commit" was correct while the description was a dashboard. #611 made
the description a commit body on purpose. The rule underneath both is the same one: **a squash commit
gets the compact reviewed summary and nothing else.**

The one remaining refusal is an EMPTY PR description, and it is now a property of the PR rather than of
this computer — which is why it has a single mechanical cure (re-run the gated flow) and no human
judgement call bolted on.

## 4. The one fact GitHub could not answer, and why it is re-derived rather than re-homed

`wp-land-pr` does two things at different scopes. The merge belongs to the PR. The BOOKKEEPING —
archive the pre-squash tip as `archive/<date>/<branch>`, promote `merge-info/staged/<feature>`, reap the
landed worktree — belongs to the tree that holds the branch, and doing it elsewhere is not useless but
WRONG: another clone's `<branch>` is a different commit, so the tag would name the wrong objects.

0004 answered that from `origin.json`'s `treeRoot`, a recorded claim stored beside the body. That was
the last thing keeping the store alive. It is now **re-derived**: compare this tree's
`git rev-parse <branch>` against the PR's `headRefOid`.

That is strictly better, and it is better because it tests the fact that actually matters. "Which
directory rendered this" was always a proxy for "does this working tree hold the objects the PR
merged", and the proxy is wrong in both directions:

| case | `origin.json` | sha compare | which is right |
|---|---|---|---|
| same tree | archive | archive | agree |
| second clone, different commit | decline | decline | agree |
| **linked worktree of the same clone** | **decline** (different path) | **archive** | sha — git shares refs across worktrees of one clone, so `<branch>` there IS the landed commit |
| **second clone sitting on the same commit** | **decline** | **archive** | sha — the tag would name the right objects |
| **posting tree with commits made after finish** | **archive** | **decline** | sha — `<branch>` is no longer what the PR squashed |

That last row is a defect `origin.json` had and nobody noticed: it would archive a tip the PR never
contained, under a name asserting it did.

The decline message names both shas and both plausible causes, so the reader can tell which one they
are in. And when it declines it declines *loudly* and the merge still stands — unchanged from 0004 § 5.

**Rejected:** keeping `origin.json` alone in `~/.webpieces`. One sidecar is the same directory, the same
sweep, the same "does this machine have it" question, for a fact two `rev-parse`s already answer.

## 5. Retention (0001 § O3) is now moot for this artifact

`cleanTmp` swept two roots: `{repo}/.webpieces` and `~/.webpieces/prs`. The second existed because it
outlived every clone — `rm -rf <clone>` would never reap it — which was a cost 0004 accepted, not a
benefit. With the store gone there is one root, `{repo}/.webpieces`, and it dies with the clone that
owns it. `AgedTreeSweeper` stays extracted (it is the sweep policy, testable on its own root) even
though it now has one caller.

## 6. `pr-merge-guard` stays blocking

Re-examined for the second time (0004 § 8 was the first), and the block on any hand-rolled
`gh pr merge` stands. One of its three legs is gone — there is no `--fallback-title-only` stamp to
protect — and the other two are unchanged and sufficient:

- A `--body-file` proves a file was passed, never that it holds the reviewed bytes. The guard sees a
  command string and cannot read the file.
- Landing DECIDES whose bookkeeping this is (§ 4). A hand-rolled merge skips that decision silently,
  which is how a landed worktree becomes a corpse.

## 7. Release ordering (this is not optional)

`node_modules/@webpieces/*` is one release behind local source and its `wp-land-pr` still reads
`~/.webpieces/prs`. So during the transition the installed command and this source disagree:

1. **land this PR** (source only),
2. **publish** the tooling release, `pnpm install` in every consuming repo,
3. **only then** is `rm -rf ~/.webpieces` safe on a developer's machine.

Deleting the directory before step 2 makes the *installed* `wp-land-pr` refuse with "PR #N was not found
on this machine" — recoverable (re-run `pnpm wp-finish-upsert-pr`, or land after upgrading) but avoidable.
Nothing in this PR touches anyone's home directory.

## 8. Rejected

| option | why not |
|---|---|
| **Keep the store as a cache, read the PR when it misses** | Two homes for one receipt, which is the shim shape 0004 itself rejected — and now the stale one would be the LOCAL one, winning over the authoritative remote. |
| **Keep `origin.json` only** | § 4 — the same machine-global directory and sweep for a fact two `rev-parse`s answer better. |
| **Keep `--fallback-title-only` "just in case"** | § 3 — its only trigger is unreachable. An accepted shape is never migrated (`.claude/rules/no-backwards-compat.md`). |
| **Re-render the body at land time** | Unchanged from 0004: a second authoritative gate whose result nobody reads, free to disagree with what was reviewed. |
| **Store the body in a PR comment instead of the description** | Adds a surface, and the description is already the thing every landing route copies (`squash_merge_commit_message: PR_BODY`). #611's whole point. |
| **Reinstate a machine-global root for something else later** | Not forbidden in principle — but it needs its own decision doc arguing the scope, not a revival of this one. `no-machine-global-state.spec.ts` makes the revival loud. |
