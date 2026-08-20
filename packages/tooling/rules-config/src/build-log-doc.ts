// ---------------------------------------------------------------------------
// `webpieces.buildlog.md` — where the build's output actually is.
//
// WHY THIS IS A GENERATED DOC AND NOT A PARAGRAPH IN A REPO'S CLAUDE.md. The rule "read the absolute
// `FullLog :` path THIS run printed" was written into webpieces-ts's own CLAUDE.md and stopped there.
// A fleet audit then found three consumer repos still naming a bare `.webpieces/build.log` on their
// own `origin/main` — one of them zero commits behind, so staleness was not the explanation — while
// their real logs sat in `.webpieces/worktrees/<name>/build.log`. Hand-copied guidance does not
// propagate; a webpieces PR cannot edit a consumer's CLAUDE.md, and should not.
//
// Generated guidance does propagate: this doc rides git-workflow.md's link closure, so every repo
// receives the corrected wording on its next `wp-*` command. That is the CLAUDE.md corollary applied
// to itself — name the tool, let the tool print the details.
// ---------------------------------------------------------------------------

/** The rules-config template name, and the file name it lands under in `.webpieces/instruct-ai/`. */
export const BUILD_LOG_DOC = 'webpieces.buildlog.md';
