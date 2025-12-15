Merge tools
* MUST do a git-RebaseSquash.sh every update from main
* MUST capture A(forkpoint), B(head feature branch), C(head main branch)
* Generate B-A and C-A so AI knows cleary what was changed on each
* AI now can merge with way more context ONLY  IF NO ONE DOES MERGE MAIN!!!(ie update branch in GUI is fucking bad!!)
* NOTE: only works if rebase so B-A is not including merged changes from main and only includes what the user changed
