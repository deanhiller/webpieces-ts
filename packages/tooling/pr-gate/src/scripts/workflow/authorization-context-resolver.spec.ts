import { describe, it, expect } from 'vitest';
import { DiffScope } from '@webpieces/rules-config';
import { AuthorizationContextResolver, ReviewChangedFiles } from './authorization-context-resolver';

function resolver(): AuthorizationContextResolver {
    return new AuthorizationContextResolver(null as never, null as never, new ReviewChangedFiles(new DiffScope()));
}

/**
 * The proposed scope is what a human sees at the `wp-authorize` prompt, and the default matters more than it
 * looks: the alternative to a good default is a human who types `**` to get past the question, and `**` is
 * the widening-by-absence the whole mechanism exists to keep out of easy reach.
 */
describe('AuthorizationContextResolver.proposeScopePaths', () => {
    it('collapses a deep tree to two path segments so the human sees a readable handful', () => {
        const globs = resolver().proposeScopePaths([
            'terraform/iam/roles.tf',
            'terraform/iam/bindings.tf',
            'terraform/network/vpc.tf',
        ]);
        expect(globs).toEqual(['terraform/iam/**', 'terraform/network/**']);
    });

    it('keeps a repo-root file as itself rather than inventing a glob for it', () => {
        expect(resolver().proposeScopePaths(['README.md'])).toEqual(['README.md']);
    });

    // A one-directory-deep file yields its own directory, never a bare `**` that would cover everything.
    it('never proposes a scope wider than the directories the diff actually touched', () => {
        const globs = resolver().proposeScopePaths(['src/app.ts', 'terraform/iam.tf']);
        expect(globs).toEqual(['src/**', 'terraform/**']);
        expect(globs).not.toContain('**');
    });

    it('is deduplicated and sorted, so two runs over the same diff propose the same thing', () => {
        const files = ['src/a.ts', 'src/b.ts', 'src/nested/c.ts'];
        expect(resolver().proposeScopePaths(files)).toEqual(['src/**', 'src/nested/**']);
    });

    it('proposes nothing for an empty diff — an approval with no scope grants nothing', () => {
        expect(resolver().proposeScopePaths([])).toEqual([]);
    });
});
