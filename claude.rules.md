Needed Active Dimensions for accurate debug
 * global try catches all calling one hook
 * request context values (clickId, user, etc.)
 * interface lines(contracts) with server request/response of success,fail,other
 * interface lines(contracts) with client request/response of success,fail,other
 * server.log and browser.log on filesystem

Merge tools
 * MUST do a git-RebaseSquash.sh every update from main
 * MUST capture A(forkpoint), B(head feature branch), C(head main branch) 
 * Generate B-A and C-A
 * AI now can merge with way more context
 * NOTE: only works if rebase so B-A is not including merged changes from main and only includes what the user changed

active build steps
 * prettier so diffs in github do not show 500 formatting changes
 * regraph architecture and write

eslint rules
 * toError, no use of any or unknown without eslint
 * method no more than 70 lines
 * file no more than 700 lines

BUILD time
 * build breaks on eslint ( AI can add disables which raise warnings/review)

WARNINGs for PR human review
 * build will print estlint disables added
 * build prints architecture changed (dependencies)
 * build prints architecture chagned (apis)
 * Pattern Violations from claude.patterns.md
 * changes to claude files
 * DB schema chagnes flagged

