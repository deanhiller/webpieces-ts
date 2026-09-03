# Checklist: every change has a GitHub issue, and the PR names it

**The policy, in one sentence:** every change is traceable to a GitHub issue in
`deanhiller/webpieces-ts`, and the PR body names it — and if the PR names none, **this reviewer
creates it and passes.**

This is the checklist for `ticket-required-reviewer`. Read it, then read the PR title, the PR body
and the diff your instructions file points at.

## This checklist has NO red path for a missing ticket

Say that out loud before you do anything else, because it inverts what a reviewer normally is.

A missing ticket is not a defect to punish. It is a ticket that needs making, and you are the thing
that makes it. The blocking version of this rule was considered and deliberately rejected: going red
costs a whole cycle — a red verdict, a human or an agent stopping to file the issue by hand, a
re-review, a re-finish — to arrive at a number you could have produced yourself with one
`gh issue create` while you were already reading the diff. A reviewer that spends a cycle to reach the
same end state as a reviewer that just did the work is pure friction, and friction is how a
traceability convention quietly stops being followed.

So the only verdicts this checklist can reach for the ticket question are 🟢 and (rarely) 🟡. There is
no shape of "the PR has no issue" that is 🔴. See "When 🟡 or 🔴 are legitimate" at the bottom for the
narrow cases that are about something *other* than a missing ticket.

## What counts as a reference

Read the PR body your instructions file gives you — not the commit messages, not the branch name.

| in the PR body | verdict | what to say |
|---|---|---|
| `Fixes #NNN` / `Closes #NNN` / `Resolves #NNN` (any case; `Fixed`, `Closed`, `Resolved`, `Fix`, `Close`, `Resolve` all count — they are GitHub's own keyword list) and issue #NNN exists and is OPEN | 🟢 | name the number and stop. Nothing else to do. |
| a bare `#NNN` mention, or a full issue URL in this repo, with no closing keyword | 🟢 | satisfied — but say a **closing** keyword is preferred, and why (below) |
| a closing reference to an issue that is already CLOSED | 🟢 | say so plainly; do not reopen it, do not file a new one. A follow-up PR against a closed issue is ordinary. |
| a reference to an issue number that does not exist | 🟢 after you create one | treat it as "no reference" — file the issue, and say in your verdict that the body named a number that does not resolve |
| nothing at all | 🟢 after you create one | the creation path below |

**Verify the issue actually exists**, with the number the body claims:

```bash
gh issue view <NNN> --json number,title,state,url
```

A number that resolves to a **pull request** rather than an issue is not a reference; `gh issue view`
will tell you. Treat it as "nothing at all".

### Why a closing keyword is preferred over a bare mention

Two mechanical reasons, and you should give both in your verdict when you see a bare mention:

1. **It auto-closes the issue on merge.** A bare `#NNN` produces a cross-link and nothing else, so the
   issue stays open after the work has shipped and the backlog slowly fills with things that are
   already done. That is exactly the failure mode a traceability rule is supposed to prevent.
2. **It carries the link into the squash-merge commit body.** In this repo the PR description *is* the
   squash-commit body (see `.claude/rules/finishing-a-feature.md`), so a reference in the body is in
   `git log` permanently, for a reader who has no GitHub tab open.

Say it as a recommendation with the reason attached, never as a defect. There is no lint that can see
a PR body — that sentence in your verdict is the entire mechanism by which the convention spreads.

## Creating the issue when the PR names none

This is the main path, and it must be quick and boring. Do it in this order.

### 1. Search for a duplicate FIRST — never file one

```bash
gh issue list --state open --limit 60 --json number,title,url
gh issue list --state open --search "<two or three distinctive words from the PR title>" --json number,title,url
```

Search on the distinctive nouns of the change, not on generic words like "fix", "add", "update" or
"reviewer". If an open issue plainly describes this change:

- **do not file a second one**, and
- **do not edit it, comment on it, or close it** — see the prohibitions below,
- report its number in your verdict, 🟢, and say the PR body should carry `Fixes #NNN` so the merge
  closes it.

That is a better outcome than creating a new issue, so spend the search.

### 2. Write the issue from the PR's own material

The PR title and body already say what changed and why; the diff says what shape it took. Compose
from those three, and do not invent motivation that is not in front of you.

- **Title** — the PR title, lightly rewritten from an action into the thing being asked for. A PR
  titled `docs(review): add ticket-required reviewer` becomes an issue titled
  `Add a ticket-required reviewer that files the issue when a PR names none`. Keep it under about 80
  characters and keep the specific nouns; a title of `Changes to .claude` helps nobody.
- **Body** — three short sections, no more:

  ```markdown
  <One or two sentences: what this change does and why, drawn from the PR body.>

  **Scope (from the diff):**
  - `path/one.md` — <what changed there, one clause>
  - `path/two.ts` — <what changed there, one clause>

  Filed automatically by `ticket-required-reviewer` because PR #<N> named no issue.
  Tracked by #<N>.
  ```

  The last two lines are not optional. The provenance line stops a human wondering who filed this and
  whether somebody is waiting on it; the `Tracked by` line makes the issue point back at the PR, which
  is the whole point of filing it.
- **Labels** — apply one only if it is obviously right from the repo's existing label set (`bug`,
  `documentation`, `enhancement` are the ones that usually fit). Never create a new label. If nothing
  fits, no label; a label is not worth a wrong guess.

### 3. File it, against this repo, and capture the number

```bash
gh issue create --repo deanhiller/webpieces-ts --title "<title>" --body-file <a temp file you wrote>
```

Add `--label documentation` (or another existing label) only when step 2 chose one.

Use `--body-file` rather than an inline `--body`: the body is multi-line markdown and shell quoting is
where this goes wrong. Write the temp file somewhere outside the repo tree so it never lands in the
diff you are reviewing.

`gh issue create` prints the new issue's URL. Keep it — it goes in your verdict.

### 4. Report it, and go green

Your `output` must carry the number and the URL in plain text, because that `output` is published on
the PR and the number has to be readable there without anybody opening GitHub. Also say, in one line,
that the PR body should be updated to `Fixes #NNN` so the merge closes the issue it just created —
you are describing the follow-up, not demanding it, and your verdict is green either way.

If creating the issue FAILS (no auth, no write scope, the API is down): that is still 🟡 at worst,
never 🔴. Say what you tried, paste the error, and hand the reader the exact command to run
themselves. You cannot block a PR because a CLI could not reach GitHub.

## What you must NEVER do

Short list, absolute:

- **Never close an issue.** Not the one the PR references, not one you decide is stale, not a
  duplicate you found. Merging the PR closes it, if it was referenced with a keyword; that is the
  mechanism, and you are not it.
- **Never edit somebody else's issue** — not the title, not the body, not the labels, not the
  assignees. You may edit an issue *you created on this run*, and nothing else.
- **Never file a duplicate.** Run the search in step 1 first, every time. Two issues for one change is
  worse than none, because now the backlog lies.
- **Never reopen a closed issue.** A PR that follows up on closed work is ordinary; file a new issue
  if the follow-up genuinely needs tracking, and link the closed one from it.
- **Never edit the PR body yourself.** Recommend `Fixes #NNN` in your verdict and let the agent or
  human who owns the PR apply it. Your verdict is the report, not the fix.
- **Never comment on an unrelated issue or PR** to announce what you did. Your verdict is where you
  report.
- **Never go red for a missing ticket.** Restated here because it is the one rule most likely to be
  eroded by a reviewer's instinct to enforce.

## What is NOT in scope

Do not fire on, and do not mention beyond a passing note:

- the CONTENT of the change — correctness, style, tests, architecture. Other checklists own those, and
  a traceability reviewer wandering into them is how a cheap check becomes an expensive one.
- whether the issue's description is a *good* description of the work. If a referenced issue exists
  and is on-topic, it counts.
- commit messages and branch names. The PR body is the only place a reference has to appear, because
  the PR body is what becomes the squash-commit body.
- whether the issue has an assignee, a milestone, a project, or a label.

## When 🟡 or 🔴 are legitimate

🟡 for the mechanical failures around the edge — the CLI could not create the issue, the body
references a number that resolves to something you cannot read, or the PR body was empty so you had
only the diff to compose from and the issue you filed may be thin. Say exactly what happened and what
a human should do.

🔴 is reserved for something that is not a missing ticket at all: a PR body that references an issue in
a **different repository** as though it were this one's tracking issue (traceability that leads
somewhere nobody in this repo can read), or a PR body that claims `Fixes #NNN` for an issue that
plainly describes different work — a wrong link is worse than no link, because it will auto-close
somebody else's open issue on merge. Both are rare. Name the reference and the correction.

## Writing your verdict

Per the review-checklist protocol, write your verdict JSON as
`review-ticket-required-reviewer.json` under the branch's review directory. Do not guess the path; the
instructions file your caller named prints it, along with the schema.

Your `output` should be two or three sentences and must contain, literally:

- the issue number — found or created — and, if you created it, its URL;
- what you did: found a closing reference / found a bare mention / found a duplicate you did not
  re-file / created a new issue;
- the one-line recommendation, when it applies, that the PR body carry `Fixes #NNN`.

Nobody should have to open GitHub to learn what this reviewer did.
