Merge tools
* A three point merge involves A(forkpoint), B(head feature branch), C(head main branch)
* git does a 2 point merge and IDE's try to simulate a 3 point merge on top of that. PROOF: the file only has B and C not the A code !!!
* Humans and AI can do a way better job merging on 3 point merge as B-A and C-A shows the intent of each branch
* To accomplish a 3 point merge on any feature branch

Must hope either below is true for a 3 point merge (if no #2, you must first deal with merge to main :( ))
   1. any previous merges from main to feature branch were 3 point merges OR
   2. hope that a merge --squash back to main is CLEAN

BASICALLY, all developers should be doing a squashed rebase (git merge --squash is actually a rebase but replaying all your commits as a single commit)

⏺ Instructions on Performing 3-Point Merge with AI

Visual Summary with Branches and Files

┌─────────────────────────────────────────────────────────────┐
│ 1. Find fork point and record A, B, C                       │
│    git-gatherInfo.sh → git-findForkPoint.sh                 │
│    ✏️ CREATES: updatemain-hashes.json                        │
│    → FORK_POINT (A), FEATURE_HEAD (B), MAIN_HEAD (C)        │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Create backup branch                                     │
│    git checkout -b deanhiller/myFeatureBackup1              │
│    git checkout deanhiller/myFeature                        │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Update main, create squash branch from main              │
│    git checkout main && git pull origin main                │
│    git checkout -b deanhiller/myFeatureSquash               │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Attempt squash merge (on Squash branch)                  │
│    git merge --squash deanhiller/myFeature                  │
│    → If succeeds: commit and skip to step 11                │
│    → If fails: conflicts detected, continue to step 5       │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Get conflicted files list                                │
│    git diff --name-only --diff-filter=U                     │
│    ✏️ CREATES: updatemain-conflicted-files.txt               │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Loop through each conflicted file                        │
│    📖 READS: updatemain-conflicted-files.txt                 │
│    ✏️ CREATES: updatemain-${SAFE_PATH}/ directory            │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 7. Extract full files at each point (A, B, C)               │
│    git show $FORK_POINT:$file                               │
│    ✏️ CREATES: A-forkpoint.txt                               │
│                                                             │
│    git show $FEATURE_HEAD:$file                             │
│    ✏️ CREATES: B-feature.txt                                 │
│                                                             │
│    git show $MAIN_HEAD:$file                                │
│    ✏️ CREATES: C-main.txt                                    │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 8. Generate diffs showing what changed                      │
│    git diff $FORK_POINT $FEATURE_HEAD -- $file              │
│    ✏️ CREATES: B-A.diff (feature branch changes)             │
│                                                             │
│    git diff $FORK_POINT $MAIN_HEAD -- $file                 │
│    ✏️ CREATES: C-A.diff (main branch changes)                │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 9. Resolve conflicts (AI or manual)                         │
│    📖 READS: All files from steps 5-8                        │
│    AI: claude /merge                                        │
│    Manual: user resolves and commits                        │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 10. Delete old feature branch                               │
│    git branch -D deanhiller/myFeature                       │
└─────────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────────┐
│ 11. Rename squash branch to feature branch                  │
│    git branch -m deanhiller/myFeature                       │
│    git push -u --force-with-lease origin (if PR exists)     │
└─────────────────────────────────────────────────────────────┘

Files Created Summary

~/workspace/trytami/tmp/merge-${FEATURE_NAME}/
├── updatemain-hashes.json              ← Step 1
├── updatemain-conflicted-files.txt     ← Step 5
└── updatemain-src__app__component.ts/  ← Step 6 (per conflicted file)
├── A-forkpoint.txt                 ← Step 7
├── B-feature.txt                   ← Step 7
├── C-main.txt                      ← Step 7
├── B-A.diff                        ← Step 8
└── C-A.diff                        ← Step 8

3-Point Merge Diagram

          A (fork point)
         / \
        /   \
       B     C
(feature) (main)

B-A.diff = What developer changed on feature branch
C-A.diff = What changed on main since branch was created