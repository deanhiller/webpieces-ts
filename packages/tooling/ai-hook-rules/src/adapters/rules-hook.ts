#!/usr/bin/env node
// Claude Code / Codex PreToolUse adapter for the CODE-STYLE RULES hook (matcher Write|Edit|MultiEdit).
// Bash payloads pass through untouched — branch/PR/merge protection is the separate guards hook.
//
// COMPOSITION ROOT, and deliberately nothing else — see guards-hook.ts. The only difference between
// the two binaries is the HookArgs constructed here.
import 'reflect-metadata';
import { Container } from 'inversify';

import { HookApp } from './hook-app';
import { HookArgs } from './hook-outcome';

export function main(): Promise<void> {
    const container = new Container({ autobind: true });
    const app = container.get(HookApp);
    return app.run(new HookArgs('rules'));
}

if (require.main === module) {
    void main();
}
