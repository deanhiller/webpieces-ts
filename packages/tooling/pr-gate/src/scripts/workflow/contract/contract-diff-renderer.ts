import { injectable, bindingScopeValues } from 'inversify';
import { ContractChange, ContractChangeKind } from './openapi-contract-diff';

/** Hidden marker that identifies the contract-diff comment among all comments on a PR. */
export const CONTRACT_DIFF_COMMENT_MARKER = '<!-- webpieces-contract-diff -->';

/** One declared contract's partner-facing difference, merge-base → HEAD. Data-only. */
export class ContractDiffSection {
    constructor(
        /** The `openapi-generate` target's project. */
        readonly projectName: string,
        /** Workspace-relative manifest path. */
        readonly manifest: string,
        /** The document diffed, e.g. `public-openapi.json`. */
        readonly documentName: string,
        readonly baseSha: string,
        readonly headSha: string,
        /**
         * Why the merge-base side is not a document, or '' when it is. A brand-new contract, or a
         * merge-base today's generator refuses; either way every HEAD item then reads as `added`.
         */
        readonly baseNote: string,
        /** True when HEAD's contracts publish no partner-facing document at all. */
        readonly headHasNoDocument: boolean,
        readonly changes: readonly ContractChange[],
    ) {}
}

const HEADINGS: ReadonlyArray<[ContractChangeKind, string]> = [
    ['added', 'Added — newly visible to partners'],
    ['removed', 'Removed — partners lose this'],
    ['changed', 'Changed'],
];

/**
 * Renders the partner-facing contract diff as ONE PR comment.
 *
 * This comment is what replaced committing the generated documents (#986). A committed document made
 * a newly partner-visible endpoint show up as a diff; this shows the same thing where reviewers already
 * look, computed against what actually shipped at the merge-base rather than against a checked-in file
 * somebody may have regenerated wrongly or not at all — and it cannot be skipped by forgetting to run a
 * command.
 *
 * `hidden: true` on a method records what somebody TYPED. The Added section is the backstop that shows
 * what will actually SHIP, so it is listed first.
 */
@injectable(bindingScopeValues.Singleton)
export class ContractDiffRenderer {
    render(sections: readonly ContractDiffSection[]): string {
        const lines = [CONTRACT_DIFF_COMMENT_MARKER, '## Partner-facing contract changes', ''];
        for (const section of sections) {
            lines.push(...this.section(section), '');
        }
        return lines.join('\n').trimEnd() + '\n';
    }

    private section(section: ContractDiffSection): string[] {
        const lines = [
            `### \`${section.projectName}\` — \`${section.documentName}\``,
            '',
            `\`${section.manifest}\`, merge-base \`${section.baseSha.slice(0, 7)}\` → HEAD \`${section.headSha.slice(0, 7)}\`.`,
        ];
        if (section.baseNote !== '') lines.push('', `> ${section.baseNote}`);
        if (section.headHasNoDocument && section.changes.length === 0) {
            lines.push('', 'HEAD publishes no partner-facing document for this contract.');
            return lines;
        }
        if (section.changes.length === 0) {
            lines.push('', '**No partner-facing change.**');
            return lines;
        }
        for (const heading of HEADINGS) {
            const matching = section.changes.filter((change: ContractChange) => change.kind === heading[0]);
            if (matching.length === 0) continue;
            lines.push('', `**${heading[1]}**`, '');
            for (const change of matching) lines.push(this.bullet(change));
        }
        return lines;
    }

    private bullet(change: ContractChange): string {
        const detail = change.details.length === 0 ? '' : ` — ${change.details.map((each: string) => `\`${each}\``).join(', ')}`;
        return `- \`${change.subject}\`${detail}`;
    }
}
