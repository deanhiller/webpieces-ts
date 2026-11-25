import * as fs from 'fs';
import { ReviewJsonService } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';
import {
    LandedTickets, TicketLink, TICKET_SOURCE_NONE, TICKET_SOURCE_PR_BODY, TICKET_SOURCE_SUMMARY,
} from './ticket-reminder';

/**
 * Recovers, at LAND time, the tickets a PR addresses — so `wp-land-pr`'s "update your ticket" reminder
 * (issue #1456) can name them. It never invents one: a URL is printed only when it was found written down.
 *
 * Two sources, in order:
 *  1. summary.json's `addressesIssues`, when the tree that ran `wp-finish-upsert-pr` still holds it
 *     (finish leaves it in place). It is the author's own statement, with `closesIssue` on every entry.
 *  2. The PR body's `Fixes <url>` / `Part of <url>` lines, which finish rendered FROM that array — the
 *     fallback when landing runs from a tree that never had the summary (a second clone, another machine).
 *
 * Neither yields anything → {@link TICKET_SOURCE_NONE}, and the reminder points the caller at their own
 * tracker instead.
 */
@injectable(bindingScopeValues.Singleton)
export class LandedTicketResolver {
    // A whole line `Fixes <url>` or `Part of <url>` — exactly the shape IssueReferences.blockLines renders.
    private static readonly BODY_LINE = /^(Fixes|Part of) (https:\/\/\S+)$/;

    constructor(private readonly reviewJson: ReviewJsonService) {}

    /**
     * `treeRoot` is the tree that holds the landed commit (where finish wrote summary.json), `featureName`
     * the PR head branch in summary.json's directory form, and `prBody` the description GitHub holds.
     */
    resolve(treeRoot: string, featureName: string, prBody: string): LandedTickets {
        const fromSummary = this.fromSummary(this.reviewJson.summaryJsonPath(treeRoot, featureName));
        if (fromSummary.length > 0) return new LandedTickets(fromSummary, TICKET_SOURCE_SUMMARY);
        const fromBody = this.fromBody(prBody);
        if (fromBody.length > 0) return new LandedTickets(fromBody, TICKET_SOURCE_PR_BODY);
        return new LandedTickets([], TICKET_SOURCE_NONE);
    }

    private fromBody(body: string): TicketLink[] {
        const links: TicketLink[] = [];
        for (const line of body.split('\n')) {
            const match = LandedTicketResolver.BODY_LINE.exec(line.trim());
            if (match === null) continue;
            if (links.some((link: TicketLink): boolean => link.url === match[2])) continue;
            links.push(new TicketLink(match[2], match[1] === 'Fixes'));
        }
        return links;
    }

    /**
     * The well-formed `addressesIssues` entries, or [] when the file is gone or unreadable. Lenient on
     * purpose: the PR is ALREADY merged, so this only decides which URLs a reminder names — it is not the
     * gate that validates summary.json (finish already did that), and failing here would report a landed
     * PR as a failure. An unreadable file falls through to the PR body, which holds the same tickets.
     */
    private fromSummary(file: string): TicketLink[] {
        if (!fs.existsSync(file)) return [];
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable summary.json falls back to the PR body, by design
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- summary.json is opaque until narrowed field-by-field below
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            const issues = raw['addressesIssues'];
            // webpieces-disable no-any-unknown -- one opaque JSON array element, narrowed by entry()
            return Array.isArray(issues) ? issues.flatMap((item: unknown): TicketLink[] => this.entry(item)) : [];
            // webpieces-disable catch-must-propagate -- the PR is already merged; an unparseable summary.json only means the reminder reads the PR body's ticket lines instead
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    // webpieces-disable no-any-unknown -- one opaque JSON array element, narrowed here
    private entry(entry: unknown): TicketLink[] {
        if (typeof entry !== 'object' || entry === null) return [];
        // webpieces-disable no-any-unknown -- opaque JSON object; each key is narrowed below
        const record = entry as Record<string, unknown>;
        const url = record['url'];
        const closes = record['closesIssue'];
        if (typeof url !== 'string' || !url.trim().startsWith('https://') || typeof closes !== 'boolean') return [];
        return [new TicketLink(url.trim(), closes)];
    }
}
