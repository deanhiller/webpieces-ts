#!/usr/bin/env node
// Claude Code / Codex PreToolUse adapter for the GIT/PR/BRANCH GUARDS hook (matcher Bash|Write|Edit|
// MultiEdit|Read). Code-style validation is the separate rules hook.
//
// COMPOSITION ROOT, and deliberately nothing else: build the container, get the app, run it. Every
// decision this binary makes lives behind HookApp; the only thing that distinguishes it from
// rules-hook.ts is the one HookArgs it constructs.
import 'reflect-metadata';
import { Container } from 'inversify';

import { HookApp } from './hook-app';
import { HookArgs } from './hook-outcome';

export function main(): Promise<void> {
    const container = new Container({ autobind: true });
    const app = container.get(HookApp);
    return app.run(new HookArgs('guards'));
}

if (require.main === module) {
    void main();
}
