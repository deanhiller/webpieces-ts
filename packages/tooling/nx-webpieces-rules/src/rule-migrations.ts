import { RetiredConfigKey } from '@webpieces/rules-sdk';

/** Removed native fields retain their exact owner-authored repair instructions. */
export const ruleMigrations: readonly RetiredConfigKey[] = [
    new RetiredConfigKey("field", "runtime-architecture.servicePaths", "", "This field was removed — it was never read. The runtime graph is derived automatically from architecture/dependencies.json (apiRelations + project roles). Delete it.", "[runtime-architecture]", false),
    new RetiredConfigKey("field", "runtime-architecture.apiProjectPaths", "", "This field was removed — it was never read. The runtime graph is derived automatically from architecture/dependencies.json, so there is NO list of api libs to maintain. Delete it (do not enumerate api libs and do not replace it with a glob).", "[runtime-architecture]", false),
    new RetiredConfigKey("field", "runtime-architecture.allowedCycles", "", "This field was removed — a runtime cycle is not allowable at all any more. Levelling now FAILS on any cycle, because CD deploys services in dependency order and a cycle has no such order. Delete the key. If a cycle genuinely cannot be broken yet, declare it PER EDGE with a `cutLegacyCycle:<targetService>` nx tag on the CALLING project, which admits the debt where `grep -rn cutLegacyCycle` can enumerate it — there is no config key for it.", "[runtime-architecture]", false),
];
