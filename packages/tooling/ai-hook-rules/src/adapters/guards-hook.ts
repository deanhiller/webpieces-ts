// Claude Code PreToolUse adapter for the GIT/PR/BRANCH GUARDS hook (matcher Bash).
// File-edit payloads pass through untouched — code-style validation is the separate rules hook.
import { runMain } from './hook-core';

export function main(): Promise<void> {
    return runMain('guards');
}

if (require.main === module) {
    void main();
}
