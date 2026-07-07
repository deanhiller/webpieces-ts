#!/usr/bin/env node
import { runMain } from '@webpieces/rules-config';
import { gatherInfo } from './git-gatherInfo';

// Thin bin wrapper around gatherInfo(): the diagnostic entry point that just prints the 3-point merge
// context. gatherInfo NEVER exits the process — that is this wrapper's job, delegated to runMain (the
// single sanctioned process.exit site). The real flow calls gatherInfo() as a library from merge-start.
export async function main(): Promise<void> {
    await gatherInfo();
}

if (require.main === module) runMain(main);
