import { NativeProcessApi } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';

// The number and web URL GitHub will most likely assign to the next PR. Both '' when no prediction
// could be made. Data-only.
export class PredictedPr {
    number: string;
    url: string;

    constructor(number: string, url: string) {
        this.number = number;
        this.url = url;
    }
}

/*
 * Issues, PRs and discussions share ONE per-repo number counter, so the newest of the three, plus one, is
 * the number the next PR gets unless something else is created in the same few seconds. Each connection
 * is ordered explicitly (newest first) rather than relying on a connection's default order.
 */
const PREDICT_QUERY =
    'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { url ' +
    'issues(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number } } ' +
    'pullRequests(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number } } ' +
    'discussions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number } } } }';

// The newest number of the three (0 for an empty repo) and the repo's web URL, as one tab-separated line,
// so nothing here parses JSON. A connection with no nodes contributes nothing.
const PREDICT_JQ =
    '"\\(([.data.repository.issues.nodes[0].number, .data.repository.pullRequests.nodes[0].number, ' +
    '.data.repository.discussions.nodes[0].number] | map(select(. != null)) + [0]) | max)\\t\\(.data.repository.url)"';

/**
 * Predicts the number GitHub will assign to the PR about to be created (issue #1418), so its description
 * can carry its own link the FIRST time it goes up. Without it, creating a PR fires `opened` and then,
 * two seconds later, `edited` (the self-link back-fill) — and a consumer workflow with
 * `cancel-in-progress` cancels the `opened` run on every new PR.
 *
 * A number cannot be reserved, only predicted, so the caller always compares the prediction with the
 * number GitHub really assigned and back-fills on a miss — exactly today's behaviour, never worse.
 *
 * A failed query (network, permissions, a GitHub Enterprise Server without discussions) is NOT a failure
 * of the run: the prediction is simply absent, the caller creates the PR without its own link and
 * back-fills it afterwards. The warning says so, because the cost is one extra `edited` event.
 */
@injectable(bindingScopeValues.Singleton)
export class PrNumberPredictor {
    constructor(private readonly processes: NativeProcessApi) {}

    async predict(): Promise<PredictedPr> {
        const result = await this.processes.run('gh', [
            'api',
            'graphql',
            '-F',
            'owner={owner}',
            '-F',
            'name={repo}',
            '-f',
            `query=${PREDICT_QUERY}`,
            '--jq',
            PREDICT_JQ,
        ]);
        const [latest, repoUrl] = result.ok ? result.stdout.trim().split('\t') : ['', ''];
        if (!/^\d+$/.test(latest ?? '') || !(repoUrl ?? '').startsWith('http')) {
            const why = result.ok ? `unexpected answer '${result.stdout.trim()}'` : (result.stderr.trim() || `exit ${String(result.code)}`);
            process.stderr.write(
                `⚠️  Could not predict the new PR's number (${why}). Creating it without its own link and\n` +
                    "   back-filling the link afterwards (one extra 'edited' event).\n",
            );
            return new PredictedPr('', '');
        }
        const next = String(Number(latest) + 1);
        return new PredictedPr(next, `${repoUrl}/pull/${next}`);
    }
}
