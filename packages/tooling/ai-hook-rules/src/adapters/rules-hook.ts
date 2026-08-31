#!/usr/bin/env node
// Claude Code / Codex PreToolUse adapter for the CODE-STYLE RULES hook (matcher Write|Edit|MultiEdit).
// Bash payloads pass through untouched — branch/PR/merge protection is the separate guards hook.
//
// COMPOSITION ROOT, and deliberately nothing else — see guards-hook.ts. The only difference between
// the two binaries is the HookArgs constructed here.
import 'reflect-metadata';
import { Container } from 'inversify';

import { HookApp, HookBootFailure } from './hook-app';
import { HookArgs } from './hook-outcome';

// webpieces-disable no-function-outside-class -- this IS the bin's process entry point, named in package.json `exports` as ./claude-code-guards / ./claude-code-rules; a class here would be a namespace around one call and could not be the module's callable entry.
export async function main(): Promise<void> {
    const container = new Container({ autobind: true });
    const app = container.get(HookApp);
    await app.run(new HookArgs('rules'));
}

// `.catch` and not a bare `void main()`: a container that cannot be built throws BEFORE any HookApp
// exists, and an unhandled rejection exits non-zero — which PreToolUse reads as a non-blocking error
// and lets the tool call through. See HookBootFailure. `main` is async so a synchronous throw inside it
// arrives here as a rejection too.
if (require.main === module) {
    // webpieces-disable no-any-unknown -- a rejection value is `unknown` by construction; HookBootFailure narrows it through toError(), which is the one place that job belongs
    void main().catch((err: unknown): void => { new HookBootFailure().report(err); });
}
