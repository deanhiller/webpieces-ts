# Tickets: every change has a GitHub issue, and every PR names it

Read this before you write the first line of code, and again before you write `review.json`'s `summary`
— which is what `wp-finish-upsert-pr` renders into the PR body. GitHub issues
are the **single** tracker for this repo as of 2026-09 — the tracked `backlog/` directory is gone, and its
87 files were migrated into issues so that a work item can actually be closed, assigned, labelled, and
linked from a commit. A markdown file in the tree could do none of those things, which is exactly how it
accumulated 87 entries nobody could tell apart from finished ones.

## RULE 1: every PR body carries a closing reference

**The PR body MUST contain `Fixes #NNN` or `Closes #NNN`.** Not "see #NNN", not "related to #NNN" — a
closing keyword, so GitHub closes the issue the moment the PR merges and nobody has to remember to.

**It goes in the BODY. Not only the branch name, not only the commit subject.** Two mechanisms depend on
the body and neither one reads anything else:

- **GitHub's auto-close parser reads the PR description and the merge commit body.** A `#NNN` in a branch
  name is decoration; GitHub never parses it, and the issue stays open forever while the work is done.
- **This repo's gate renders the PR description INTO the squash-merge commit body** (see
  `.claude/rules/finishing-a-feature.md` — `squash_merge_commit_message: PR_BODY`, enforced by
  `SquashSettingsEnforcer` on every `wp-finish-upsert-pr`). The body is therefore the one place the link
  survives into `main`'s history. Put it anywhere else and `git log` on `main` — the only record that
  outlives the branch — has no idea why the commit exists.

**How you actually put it there: make `Fixes #NNN` the LEADING line of `review.json.summary`.** You do
not write the PR body by hand — stage ③ renders it, from `summary`, and uses the same string as the
`--body-file` it merges with. `gh pr edit` is blocked by `pr-creation-or-push-guard`, so a line you
forgot at stage ② costs a whole `wp-review-upsert-pr` → rewrite `review.json` → `wp-finish-upsert-pr`
loop to add. Put it in `summary` the first time.

**Who CHECKS it is not who can SEE it.** `ticket-required-reviewer` runs at stage ②, before the PR
exists, and its briefing is local-disk artifacts only — no PR, no body, no issue reference, by design
(issue #974). It therefore reads the branch name, the commit messages and the diff, and it carries the
requirement forward by stating the literal `Fixes #NNN` line in its verdict `output`, which the agent
assembling `review.json` reads. The FACT above is unchanged — the reference has to reach the body,
because that is what GitHub parses and what becomes the squash commit. What is delegated is only the
checking and the wording.

## RULE 2: no issue yet? Create one FIRST, before you start

**If the work you are about to do has no issue, open one before the first edit.** `gh issue create` — one
command. Do not start coding and plan to file it later; later is when you write a one-line title because
the reasoning has already been spent on the diff.

The issue is where the **reasoning** lives now that `backlog/` is gone. That is not bookkeeping. A PR
description is squashed into a single commit body and then never read again, so a rationale that exists
only there is a rationale that survives exactly as long as somebody is looking at the PR page. The issue
outlives it, gets linked from the next incident, and is what the next agent finds when it greps for
"has anyone hit this before". A migrated issue like
[#768](https://github.com/deanhiller/webpieces-ts/issues/768) is 300 lines of measurement precisely
because that detail was worth keeping — write the issue at that altitude, not at PR-title altitude.

Label it: `bug` for a defect, `enhancement` for a feature or a design change, `documentation` for a doc
or checklist. Those three are what the migration used, and adding a fourth taxonomy is a decision for a
human.

## RULE 3: a missing ticket never stalls a cycle

**A required reviewer enforces this, and it CREATES the issue and PASSES rather than blocking.** See
`.claude/agents/ticket-required-reviewer.md` for the agent and `.claude/review/ticket-required.md` for
what it checks.

That shape is deliberate, and it is the opposite of every other required checklist here. The other
reviewers go red because the diff itself is wrong and only the author can fix it. A missing issue is not
a wrong diff — it is a filing step somebody skipped, and it is fully repairable by the reviewer in one
`gh issue create` plus one line in its verdict. Blocking on it would spend a whole review round on
paperwork an agent can do in two seconds, and the predictable outcome of *that* is somebody deciding the
gate is not worth running. So the reviewer files the ticket, states the exact `Fixes #NNN` line that
must lead `review.json.summary`, and passes.

**This is not permission to skip RULE 2.** An issue the reviewer had to reconstruct from your diff is an
issue with no reasoning in it — it records *what* changed, which the diff already says, and not *why*,
which is the only part that was ever worth writing down.

**Enforcement:** `ticket-required-reviewer` (`.claude/agents/ticket-required-reviewer.md`) is REGISTERED
in `commands.pr-gate.checklists` and REQUIRED, over `**` plus `.claude/**` and `.github/**` — which is
every file in the repo, and is deliberately universal where every other checklist here is content-scoped:
this one is scoped to the BRANCH, not to the diff's content, so a one-line typo fix is in scope exactly
like a framework change is. (The two dot-directory patterns are not redundant. Checklist patterns run through
`isPathExcluded`, which calls minimatch without `{ dot: true }`, so a bare `**` measurably does not match
`.claude/rules/tickets.md` — and a docs-only PR is the shape least likely to be ticketed by hand.)

**There is no red path for a missing ticket, so "enforcement" here means the issue gets CREATED, not that
the PR gets blocked.** That is the whole of RULE 3 restated at the checklist level: the reviewer files the
issue, states the `Fixes #NNN` line for `review.json.summary`, and passes green. It is also the first
checklist in
this repo that WRITES to GitHub rather than only reporting — every reviewer before it reads the diff and
emits a verdict, and this one takes an action in the outside world. `.claude/review/ticket-required.md` is
what it reads, and it is where the checks live. It keeps a red verdict only for the two shapes that are
not a missing ticket at all — local evidence pointing at an issue in a DIFFERENT repository, and a
closing reference aimed at an issue that plainly describes other work, which on merge auto-closes
somebody else's open issue. A wrong link is worse than no link; no link, it just files one.

**It is scoped to the BRANCH, not to a PR that does not exist yet.** The reviewer's evidence is the
branch name, the commit messages and the diff — everything on local disk at stage ②. That is the
correction issue #974 bought: the checklist used to tell it to "read the PR body", which it is never
given and by design never should be, so RULE 1 was structurally uncheckable and the reviewer passed
green twice without having verified anything. A reviewer that could only check the body would have to
run after the PR was posted, which is after the point where gating means anything.
