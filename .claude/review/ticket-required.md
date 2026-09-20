# Checklist: every change has a GitHub issue, and the closing reference reaches the squash body

**The policy, in one sentence:** every change is traceable to a GitHub issue in
`deanhiller/webpieces-ts`, the `Fixes #NNN` line has to end up in the PR body — and if this branch
names no issue, **this reviewer creates it, states the exact line, and passes.**

This is the checklist for `ticket-required-reviewer`.

## You run BEFORE the PR exists. There is no PR body to read.

Say this out loud before anything else, because the previous version of this file got it wrong and
the reviewer passed green on two PRs in a row without having checked anything (issue #974).

You are spawned by `pnpm wp-review-upsert-pr` — **stage ②**. Stage ③ (`wp-finish-upsert-pr`) is what
creates the PR and renders its body. At the moment you run:

- there is usually **no PR at all** (`gh pr list --head <branch>` returns `[]` on a first-time PR);
- `pr-body.md` in the review directory **does not exist yet** — stage ③ writes it, minutes after the
  last verdict lands;
- `review.json` may or may not be there. Stage ② tells the main agent to write it at STEP 1, *before*
  it spawns you at STEP 2, so it is usually present — but it is a DRAFT written by the same agent that
  authored the diff, it is simply absent if that agent has not written it yet, and on a re-run of
  stage ② it can be the previous round's file. Stage ③ MOVES it to `old-review.json` when it
  publishes, so the live path is empty again on the next cycle.

**`review.json` is not the PR body, and it is not evidence.** It is the draft your verdict is supposed
to CORRECT — stage ③ has not rendered anything from it yet. Handle both states honestly: read it if it
is there, treat "not found" as ordinary, and in either case do step 3.

Your briefing (`ReviewerBriefing`) is entirely local-disk artifacts — diff paths, source paths,
manifest, verdict path, shas. **It contains no PR body, no PR number and no issue reference, and it
should not.** A reviewer that gated on the PR would have to run after the PR was posted, which is
after the point where gating means anything.

So you check what is actually on disk, and you carry the requirement FORWARD in your verdict.

## This checklist has NO red path for a missing ticket

A missing ticket is not a defect to punish. It is a ticket that needs making, and you are the thing
that makes it. The blocking version of this rule was considered and deliberately rejected: going red
costs a whole cycle — a red verdict, a human or an agent stopping to file the issue by hand, a
re-review, a re-finish — to arrive at a number you could have produced yourself with one
`gh issue create` while you were already reading the diff. A reviewer that spends a cycle to reach the
same end state as a reviewer that just did the work is pure friction, and friction is how a
traceability convention quietly stops being followed.

So the only verdicts this checklist can reach for the ticket question are 🟢 and (rarely) 🟡. There is
no shape of "this branch has no issue" that is 🔴. See "When 🟡 or 🔴 are legitimate" at the bottom for
the narrow cases that are about something *other* than a missing ticket.

## Step 1 — find the issue number in the local evidence

Run these from the repo root your briefing gives you. Take the FIRST one that yields a number, and
say in your verdict which one it was.

```bash
git rev-parse --abbrev-ref HEAD                              # branch name — e.g. dean/974-reviewer-reads-local-artifacts
git log <forkPointSha>..<featureHeadSha> --format='%s%n%b'   # both shas are printed in your briefing
```

| what the local evidence yields | verdict | what to say |
|---|---|---|
| a branch name or commit body naming issue #NNN, and `gh issue view NNN` resolves to an OPEN issue in this repo | 🟢 | name the number, and state the `Fixes #NNN` line (step 3) |
| a number that resolves to a CLOSED issue | 🟢 | say so plainly; do not reopen it, do not file a new one. A follow-up PR against a closed issue is ordinary. Still state the `Fixes #NNN` line. |
| a number that does not resolve, or resolves to a **pull request** rather than an issue | 🟢 after you create one | treat it as "nothing at all", and say in your verdict that the branch named a number that does not resolve |
| nothing at all | 🟢 after you create one | the creation path in step 2 |

**Always verify the number rather than trusting the string:**

```bash
gh issue view <NNN> --json number,title,state,url
```

A branch name is a *hint*, not a reference — GitHub never parses one, which is precisely why step 3
exists. Do not treat "the branch has the number in it" as the requirement being met.

### Two optional artifacts — use them if present, never depend on them

- **An already-open PR for this branch.** Only on a re-run of the cycle:
  `gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --json number,body`. If that comes back
  `[]`, that is the *normal* case and it says nothing about the change. Never report `[]` as a
  finding.
- **`review.json`**, in the directory holding your verdict file (the parent of the `verdictPath` your
  briefing names). Usually present, because stage ② has the main agent write it before spawning you —
  but it is that agent's DRAFT, or a previous round's file, and stage ③ has rendered nothing from it
  yet. If its `summary` already LEADS with a correct `Fixes #NNN`, say so in your verdict and repeat
  the line anyway. If it does not, or the file is absent, that is the ordinary case — say the number
  you settled on and give the line. Either way you do step 3; nothing here is a reason to skip it, and
  a missing file is never a finding.

If neither is present, that is a state you handle, not a defect you report. Proceed.

## Step 2 — creating the issue when the branch names none

This is the main path, and it must be quick and boring. Do it in this order.

### 2a. Search for a duplicate FIRST — never file one

```bash
gh issue list --state open --limit 60 --json number,title,url
gh issue list --state open --search "<two or three distinctive words from the change>" --json number,title,url
```

Search on the distinctive nouns of the change, not on generic words like "fix", "add", "update" or
"reviewer". If an open issue plainly describes this change:

- **do not file a second one**, and
- **do not edit it, comment on it, or close it** — see the prohibitions below,
- report its number in your verdict, 🟢, and give the `Fixes #NNN` line for it in step 3.

That is a better outcome than creating a new issue, so spend the search.

### 2b. Write the issue from the material you actually have

Your material is the DIFF, the commit subjects and bodies on this branch, and the branch name. The
commit messages are where the author's own words live now that there is no PR body to draw on — read
them before you compose, and do not invent motivation that is not in front of you.

- **Title** — the change stated as the thing being asked for, not as an action already taken. A
  branch whose commits say `docs(review): add ticket-required reviewer` becomes an issue titled
  `Add a ticket-required reviewer that files the issue when a branch names none`. Keep it under about
  80 characters and keep the specific nouns; a title of `Changes to .claude` helps nobody.
- **Body** — three short sections, no more:

  ```markdown
  <One or two sentences: what this change does and why, drawn from the commit messages and the diff.>

  **Scope (from the diff):**
  - `path/one.md` — <what changed there, one clause>
  - `path/two.ts` — <what changed there, one clause>

  Filed automatically by `ticket-required-reviewer` while gating branch `<branch>` before its PR was
  posted, because the branch named no issue.
  ```

  The provenance line is not optional: it stops a human wondering who filed this and whether somebody
  is waiting on it. There is deliberately no `Tracked by #<N>` line — **you do not know the PR number,
  because the PR does not exist yet.** Do not guess one, and do not go hunting for one to make the
  sentence work.
- **Labels** — apply one only if it is obviously right from the repo's existing label set (`bug`,
  `documentation`, `enhancement` are the ones that usually fit). Never create a new label. If nothing
  fits, no label; a label is not worth a wrong guess.

### 2c. File it, against this repo, and capture the number

```bash
gh issue create --repo deanhiller/webpieces-ts --title "<title>" --body-file <a temp file you wrote>
```

Add `--label documentation` (or another existing label) only when step 2b chose one.

Use `--body-file` rather than an inline `--body`: the body is multi-line markdown and shell quoting is
where this goes wrong. Write the temp file somewhere outside the repo tree so it never lands in the
diff you are reviewing.

`gh issue create` prints the new issue's URL. Keep it — it goes in your verdict.

## Step 3 — carry the requirement forward. This is the part that does the work.

You cannot put the line in the PR body yourself, and you must never try. What you CAN do is tell the
agent that writes the body, mechanically, in the one channel that reaches it: your verdict `output`
is read by the main agent assembling `review.json`, and `review.json.summary` is what stage ③ renders
into **both** the PR description and the squash-merge commit body.

So your `output` must contain, on its own line and character for character:

```
Fixes #NNN
```

and the sentence that says where it goes:

> `Fixes #NNN` must be the LEADING line of `review.json.summary`, so `wp-finish-upsert-pr` renders it
> into the PR body and into the squash-merge commit.

Write the real number, never the literal `NNN`. Do this whether you FOUND the issue or CREATED it —
finding one changes nothing about whether the line reaches the body.

**Two mechanical reasons to give, in one line, for why it is a closing keyword and not a bare
`#NNN`:** a closing keyword auto-closes the issue when the PR merges, so the backlog does not fill up
with shipped work; and because the PR description *is* the squash-commit body in this repo (see
`.claude/rules/finishing-a-feature.md`), the reference lands in `git log` permanently, for a reader
with no GitHub tab open.

That sentence in your verdict is the entire mechanism by which the reference reaches the body. There
is no lint downstream that checks for it — grepping the installed `@webpieces/pr-gate` for
`Fixes|Closes|Resolves` returns nothing.

If creating the issue FAILS (no auth, no write scope, the API is down): that is still 🟡 at worst,
never 🔴. Say what you tried, paste the error, and hand the reader the exact command to run
themselves. You cannot block a PR because a CLI could not reach GitHub.

## What you must NEVER do

Short list, absolute:

- **Never treat a missing PR as a finding.** There is no PR yet. That is the design, not a defect,
  and not something to mention beyond the one line in your verdict saying which artifact you used.
- **Never close an issue.** Not the one this branch references, not one you decide is stale, not a
  duplicate you found. Merging the PR closes it, if it was referenced with a keyword; that is the
  mechanism, and you are not it.
- **Never edit somebody else's issue** — not the title, not the body, not the labels, not the
  assignees. You may edit an issue *you created on this run*, and nothing else.
- **Never file a duplicate.** Run the search in step 2a first, every time. Two issues for one change
  is worse than none, because now the backlog lies.
- **Never reopen a closed issue.** A PR that follows up on closed work is ordinary; file a new issue
  if the follow-up genuinely needs tracking, and link the closed one from it.
- **Never edit a PR body, and never create or push anything.** `gh pr edit` and `gh pr create` are
  blocked by `pr-creation-or-push-guard` anyway. Your verdict is the report, and step 3 is the fix.
- **Never write `review.json` yourself.** That file belongs to the main agent; you write exactly one
  file, your own verdict.
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
- whether the branch name is well formed. It is a hint you read a number out of, nothing more.
- whether the issue has an assignee, a milestone, a project, or a label.

## When 🟡 or 🔴 are legitimate

🟡 for the mechanical failures around the edge — the CLI could not create the issue, the local
evidence references a number that resolves to something you cannot read, or the branch carried no
number AND its commit messages were bare enough that the issue you filed may be thin. Say exactly
what happened and what a human should do.

🔴 is reserved for something that is not a missing ticket at all:

- local evidence pointing at an issue in a **different repository** as though it were this one's
  tracking issue — traceability that leads somewhere nobody in this repo can read; or
- a closing reference aimed at an issue that plainly describes different work. A wrong link is worse
  than no link, because on merge it auto-closes somebody else's open issue.

Both are rare. Name the reference and the correction.

## Writing your verdict

Per the review-checklist protocol, write your verdict JSON as
`review-ticket-required-reviewer.json` under the branch's review directory. Do not guess the path; the
instructions file your caller named prints it, along with the schema.

Your `output` should be three or four sentences and must contain, literally:

- the issue number — found or created — and, if you created it, its URL;
- which local artifact you got it from (branch name, commit message, an already-open PR, or "none — I
  filed it");
- **the `Fixes #NNN` line itself**, with the real number, plus the sentence saying it must lead
  `review.json.summary`;
- the one-line reason a closing keyword beats a bare mention.

Nobody should have to open GitHub to learn what this reviewer did, and the agent writing
`review.json` should not have to remember anything you could have told it.
