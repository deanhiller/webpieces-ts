import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The tickets came from summary.json's `addressesIssues` (still on disk at land time). */
export const TICKET_SOURCE_SUMMARY = 'summary.json addressesIssues';
/** The tickets came from the PR body's rendered `Fixes <url>` / `Part of <url>` lines. */
export const TICKET_SOURCE_PR_BODY = 'the PR body\'s "Fixes <url>" / "Part of <url>" lines';
/** No ticket URL could be recovered from either place. */
export const TICKET_SOURCE_NONE = 'none';

/**
 * Data-only: one ticket a PR addresses, and whether that PR finishes it. `closesIssue` is true for a
 * `Fixes <url>` (this PR completes the ticket) and false for a `Part of <url>` (more PRs are owed).
 */
export class TicketLink {
    url: string;
    closesIssue: boolean;

    constructor(url: string, closesIssue: boolean) {
        this.url = url;
        this.closesIssue = closesIssue;
    }
}

/** Data-only: the tickets a LANDED PR addresses, and where they were read from (a TICKET_SOURCE_*). */
export class LandedTickets {
    links: TicketLink[];
    source: string;

    constructor(links: TicketLink[], source: string) {
        this.links = links;
        this.source = source;
    }
}

/**
 * THE one wording of the "link this PR FROM its ticket" next action — printed by `wp-finish-upsert-pr`
 * after it posts or updates a PR (issue #1453) and again by `wp-land-pr` after it lands one (issue #1456).
 *
 * The PR body's `Fixes <url>` / `Part of <url>` line links the PR TO its ticket; nothing links the ticket
 * back to the PR, and on a tracker outside GitHub (Linear, Jira) nothing ever will unless the caller does
 * it. One ticket often spans several PRs, so the reminder says to ADD the link, keeping the earlier ones —
 * and it says plainly that webpieces updated no ticket, because it contacts no tracker.
 *
 * Landing repeats it because the stage-③ reminder is printed many turns before the PR reaches main, and
 * by then it has usually been forgotten. Landing is also the moment a Linear or Jira ticket should move
 * to Done, which a reminder printed while the PR is still open cannot say.
 *
 * Both entry points print nothing for a PR URL of '' — better no reminder than a link that is not real.
 */
@injectable(bindingScopeValues.Singleton)
export class TicketReminder {
    /**
     * The stage-③ form. `done` is FinishBanner.isDone of the merge outcome: when false the PR exists but
     * is not merged, so the reminder says so instead of implying a finished run.
     */
    forPostedPr(prUrl: string, done: boolean, ticketUrls: string[]): string {
        if (prUrl === '') return '';
        const state = done
            ? ''
            : '   (The PR is open but NOT merged — see step 4. The link is still correct to add now.)\n';
        const list = ticketUrls.length === 0
            ? '   summary.json names no addressesIssues ticket — use the ticket in your tracker this work belongs to.\n'
            : `   Ticket(s) this PR addresses (${TICKET_SOURCE_SUMMARY}):\n` +
              ticketUrls.map((url: string): string => `       ${url}\n`).join('');
        return this.heading(`to this PR: ${prUrl}\n`) + state + this.obligations() + list;
    }

    /** The `wp-land-pr` form: the PR is merged, so the wording is LANDED and covers moving to Done. */
    forLandedPr(prUrl: string, tickets: LandedTickets): string {
        if (prUrl === '') return '';
        const done =
            '   It is merged into main. When this PR completes a ticket\'s work, this is also the moment to\n' +
            '   move a Linear or Jira ticket to Done (a GitHub issue named by a "Fixes" line closes itself).\n';
        return this.heading(`to this LANDED (merged) PR: ${prUrl}\n`) + done + this.obligations() +
            this.landedList(tickets);
    }

    private heading(target: string): string {
        return '\n' + SEP +
            '📌 NEXT ACTION — UPDATE YOUR TICKET (Linear, Jira, GitHub issue, or another tracker) with a link\n' +
            `   ${target}`;
    }

    private obligations(): string {
        return '   Keep the links to earlier PRs so the ticket lists every PR associated with the work.\n' +
            '   webpieces did NOT update any ticket — it contacts no tracker. Adding the link is yours to do.\n';
    }

    private landedList(tickets: LandedTickets): string {
        if (tickets.links.length === 0) {
            return `   No ticket URL found in ${TICKET_SOURCE_SUMMARY} or in the PR body — use the ticket in your\n` +
                '   tracker this work belongs to.\n';
        }
        return `   Ticket(s) this PR addresses (${tickets.source}):\n` +
            tickets.links.map((link: TicketLink): string => link.closesIssue
                ? `       ${link.url}   (Fixes — this PR completes it)\n`
                : `       ${link.url}   (Part of — more PRs are owed; leave it open)\n`).join('');
    }
}
