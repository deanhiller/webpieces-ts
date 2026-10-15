import { RetiredConfigKey } from '@webpieces/rules-sdk';

/**
 * The rules whose own `allowedPaths` meant "do not judge these files" (#1253). That field is gone: the
 * framework-owned `excludePaths`, which EVERY rule accepts and the dispatcher applies, replaced it.
 * There is no alias — the old key fails the config load with this instruction.
 */
export const RENAMED_ALLOWED_PATHS_RULES: readonly string[] = [
    'max-file-lines',
    'no-destructure',
    'no-symbol-di-tokens',
    'no-function-outside-class',
    'inject-annotation-not-needed-for-concrete-class',
    'no-client-creation-outside-server-or-client',
    'one-enum-spelling-in-api-lib',
    'no-inline-import-in-api-lib',
    'no-utility-types-in-api-lib',
    'required-type-suffix',
];

/**
 * The exact edit for one retired `<rule>.allowedPaths` (#1253). Generic over the rule id, so the
 * sentence is written once for all ten rules.
 */
export class AllowedPathsMigration {
    instruction(ruleId: string): string {
        return (
            `"allowedPaths" was renamed to "excludePaths" — a framework field every rule now accepts (#1253). ` +
            `Rename the key inside the "${ruleId}" entry and keep its globs; they are matched against the ` +
            `workspace-relative path ("**" any depth, "*" one segment), so write a tree as "dir/**". To exclude ` +
            `a path from EVERY rule instead, list it in the top-level "excludePaths" of webpieces.config.json.`
        );
    }

    retired(ruleId: string): RetiredConfigKey {
        return new RetiredConfigKey(
            'field',
            `${ruleId}.allowedPaths`,
            `${ruleId}.excludePaths`,
            this.instruction(ruleId),
            `[${ruleId}]`,
            false,
        );
    }
}

/** Rejected obsolete code-rules fields, each with its exact repair instruction. */
export const ruleMigrations: readonly RetiredConfigKey[] = RENAMED_ALLOWED_PATHS_RULES.map(
    (ruleId: string) => new AllowedPathsMigration().retired(ruleId),
);
