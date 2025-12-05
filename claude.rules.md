eslint rules
* generate graph to architecture/dependencies.json FROM project.json files
* validate package.json files match project.json files or break build
* no circ deps on generated graph (moduleA -> moduleB -> moduleA fails)
  * Need AI instructions on how to fix
  * If no architecture: instruct user to generate and checkin
* files do not violate the graph (they will if allowed, fucking AI)
  * Need AI instructions on how to fix
  * If no architecture: instruct user to generate as
  * If violations, instruct AI/user is this architecture change intentional and to regen architecture if so 
* no circ deps on files within module (madge?)
  * Need AI instructions on how to fix
* no try..catch except disable rule comment (very useful for ensuring global try..catch is used which is how we tell AI /debugBug {errorId})
* try..catch() { toError(x) except disable rule comment
* method no more than 70 lines except disable rule comment with AI instructions on fixing when violated
* file no more than 700 lines except disable rule comment with AI instructions on fixing when violated
* no use of any except disable rule comment

Needed Active Dimensions for accurate debug
 * global try catches all calling one hook
 * request context values (clickId, user, etc.)
 * interface lines(contracts) with server request/response of success,fail,other
 * interface lines(contracts) with client request/response of success,fail,other
 * server.log and browser.log on filesystem

Merge tools
 * MUST do a git-RebaseSquash.sh every update from main
 * MUST capture A(forkpoint), B(head feature branch), C(head main branch) 
 * Generate B-A and C-A so AI knows cleary what was changed on each
 * AI now can merge with way more context ONLY  IF NO ONE DOES MERGE MAIN!!!(ie update branch in GUI is fucking bad!!)
 * NOTE: only works if rebase so B-A is not including merged changes from main and only includes what the user changed

active build steps
 * prettier so diffs in github do not show 500 formatting changes
 * regraph architecture and write

BUILD time
 * build breaks on eslint ( AI can add disables which raise warnings/review)

WARNINGs for PR human review
 * build will print estlint disables added
 * build prints architecture changed (dependencies)
 * build prints architecture chagned (apis)
 * Pattern Violations from claude.patterns.md
 * changes to claude files
 * DB schema chagnes flagged

