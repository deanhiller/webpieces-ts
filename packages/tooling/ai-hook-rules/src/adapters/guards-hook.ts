#!/usr/bin/env node
// Claude Code / Codex PreToolUse adapter for the GIT/PR/BRANCH GUARDS hook (matcher Bash|Write|Edit|
// MultiEdit|Read). Code-style validation is the separate rules hook.
//
// COMPOSITION ROOT, and deliberately nothing else: build the container, get the app, run it. Every
// decision this binary makes lives behind HookApp; the only thing that distinguishes it from
// rules-hook.ts is the one HookArgs it constructs.
import 'reflect-metadata';
import { Container } from 'inversify';

import { HookApp, HookBootFailure } from './hook-app';
import { HookArgs } from './hook-outcome';

export async function main(): Promise<void> {
    const container = new Container({ autobind: true });
    const app = container.get(HookApp);
    await app.run(new HookArgs('guards'));
}

// `.catch` and not a bare `void main()`: a container that cannot be built throws BEFORE any HookApp
// exists, and an unhandled rejection exits non-zero — which PreToolUse reads as a non-blocking error
// and lets the tool call through. See HookBootFailure. `main` is async so a synchronous throw inside it
// arrives here as a rejection too.
if (require.main === module) {
    void main().catch((err: unknown): void => { new HookBootFailure().report(err); });
}
