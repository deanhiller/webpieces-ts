import { SafeguardDefinition } from '@webpieces/rules-sdk';
import { L0_FAULT_NAMES } from '@webpieces/rules-config';
import { CODEX_SUBAGENT_RULE } from './adapters/codex-subagent-guard';

/** Existing keyless checks, cataloged for discovery without introducing config switches. */
export const safeguardCatalog: readonly SafeguardDefinition[] = [
    ...Object.values(L0_FAULT_NAMES).map(id => new SafeguardDefinition(id, 'fixed', 'L0 tooling integrity; enforced by the managed shim and workflow hook.')),
    new SafeguardDefinition(CODEX_SUBAGENT_RULE, 'fixed', 'Protect the shared coordinator tree and require reviewer verdicts through wp-write-review.'),
    new SafeguardDefinition('commit-message-substitution-guard', 'fixed', 'Reject shell substitution in commit messages.'),
    new SafeguardDefinition('build-output-pipe-guard', 'fixed', 'Preserve build evidence instead of piping away its output.'),
    new SafeguardDefinition('wait-spin-guard', 'fixed', 'Reject shell wait loops that spin without progress.'),
    new SafeguardDefinition('whole-repo-build-guard', 'experimental', 'Opt in through experimental.whole-repo-build-guard in the optional machine-local config.'),
];
