#!/usr/bin/env node
import { WpOpenApiMain } from './WpOpenApiMain';

/**
 * The `wp-openapi` bin. It is four lines because everything it does lives in {@link WpOpenApiMain},
 * which the suite runs exactly as a user does — a bin whose body is only reachable by spawning a
 * process is a bin nothing tests.
 *
 * The bin is declared in `publishConfig.bin`, never at the top level
 * (`.claude/rules/packaging-and-bins.md`): pnpm chmods every `bin` target while linking a package
 * from its SOURCE directory, where `src/` holds only `.ts` until tsc runs, so a top-level `bin` makes
 * every `pnpm install` print an ENOENT warning. `scripts/publish-packages.sh` hoists it into the
 * PUBLISHED manifest, and fails the release if it ever goes missing.
 */
// webpieces-disable no-process-exit-outside-main -- this IS main; WpOpenApiMain never touches the process
process.exitCode = new WpOpenApiMain().run(process.argv.slice(2), process.cwd(), process.stdout);
