// Combined Claude Code PreToolUse adapter (matcher Write|Edit|MultiEdit|Bash) — runs BOTH the
// code-style rules and the git/PR/branch guards. Kept for the back-compat `wp-ai-hook` bin and the
// `./claude-code` package export. New installs wire the two split hooks (rules-hook / guards-hook)
// independently; this combined entry simply runs everything.
import { runMain } from './hook-core';

export function main(): Promise<void> {
    return runMain('all');
}

if (require.main === module) {
    void main();
}
