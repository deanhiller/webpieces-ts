##validator rules
- validate-no-cycles - Explicitly validates cycles
- validate-packagejson - Explicitly validates package.json matches project.json
- validate-architecture-unchanged - Validates against blessed graph
    - ADD AI instructions 1. how to fix, 2. ask user before changing arch!
- validate-no-skiplevel-deps - Validates transitive dependencies
- validate-new-method - cannot be done in lint as we need context if it is new method to force AI to write cleaner smaller methods that read like a table of contents in a book(self documenting code).

##actions##
* generate graph to architecture/dependencies.json FROM project.json files

eslint rules
* no circ deps on files within module (madge?)
    * Need AI instructions on how to fix
* depending on existing transitive dep directly breaks build to simplify graph picture for human quick understanding
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

