import { describe, it, expect, beforeEach } from 'vitest';
import { ClientRegistry } from '../ClientRegistry';
import { templateDeriver } from '../templateDeriver';

describe('templateDeriver (the non-GCP answer: any predictable DNS)', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('substitutes {svc}', async () => {
        const derive = templateDeriver('https://{svc}.example.com');
        expect(await derive('helper-fsdb')).toBe('https://helper-fsdb.example.com');
    });

    it('substitutes extra vars alongside {svc}', async () => {
        const derive = templateDeriver('https://{svc}.{env}.example.com', { env: 'qa' });
        expect(await derive('helper-portal')).toBe('https://helper-portal.qa.example.com');
    });

    it('throws on an unsubstituted placeholder rather than shipping a bogus hostname', async () => {
        const derive = templateDeriver('https://{svc}.{env}.example.com');
        await expect(derive('helper-fsdb')).rejects.toThrow(/no value for \{env\}/);
    });

    it('drives the whole chain: an AWS deployment installs it, mappings still override', async () => {
        ClientRegistry.setDeriver(templateDeriver('https://{svc}.example.com'));
        ClientRegistry.addUrlMapping('legacy', 'https://legacy.corp:9000');

        expect(await ClientRegistry.resolve('helper-fsdb')).toBe('https://helper-fsdb.example.com');
        expect(await ClientRegistry.resolve('legacy')).toBe('https://legacy.corp:9000');
    });
});
