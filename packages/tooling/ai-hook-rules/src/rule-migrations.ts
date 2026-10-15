import { RetiredConfigKey } from '@webpieces/rules-sdk';

/**
 * Rejected obsolete ai-hook-rules fields, each with its exact repair instruction. `no-js-files.allowedPaths`
 * meant "do not judge these files"; the framework-owned `excludePaths`, which every rule accepts and the
 * engine applies, replaced it (#1253). There is no alias.
 */
export const ruleMigrations: readonly RetiredConfigKey[] = [
    new RetiredConfigKey(
        'field',
        'no-js-files.allowedPaths',
        'no-js-files.excludePaths',
        '"allowedPaths" was renamed to "excludePaths" — a framework field every rule now accepts (#1253). ' +
            'Rename the key inside the "no-js-files" entry and keep its globs; they are matched against the ' +
            'workspace-relative path ("**" any depth, "*" one segment), so write a tree as "dir/**". To exclude ' +
            'a path from EVERY rule instead, list it in the top-level "excludePaths" of webpieces.config.json.',
        '[no-js-files]',
        false,
    ),
];
