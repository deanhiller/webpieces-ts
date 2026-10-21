#!/usr/bin/env node
import { WpOpenApiImportMain } from './WpOpenApiImportMain';

/**
 * The `wp-openapi-import` bin. Everything it does lives in {@link WpOpenApiImportMain}, which the
 * suite runs exactly as a user does. The bin is declared in `publishConfig.bin`, never at the top
 * level (`.claude/rules/packaging-and-bins.md`); `scripts/publish-packages.sh` hoists it into the
 * published manifest.
 */
// webpieces-disable no-process-exit-outside-main -- this IS main; WpOpenApiImportMain never touches the process
process.exitCode = new WpOpenApiImportMain().run(process.argv.slice(2), process.cwd(), process.stdout);
