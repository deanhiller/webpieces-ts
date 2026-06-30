/**
 * @deprecated Re-exports the canonical git/diff helpers now centralized in @webpieces/rules-config.
 * Kept so existing `./diff-utils` importers keep working; prefer importing from '@webpieces/rules-config'.
 */
export {
    getFileDiff,
    getChangedLineNumbers,
    findNewMethodSignaturesInDiff,
    hasChangesInRange,
    isNewOrModified,
} from '@webpieces/rules-config';
