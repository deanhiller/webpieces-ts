// Claude Code PreToolUse adapter for the CODE-STYLE RULES hook (matcher Write|Edit|MultiEdit).
// Bash payloads pass through untouched — branch/PR/merge protection is the separate guards hook.
import { runMain } from './hook-core';

export function main(): Promise<void> {
    return runMain('rules');
}

if (require.main === module) {
    void main();
}
