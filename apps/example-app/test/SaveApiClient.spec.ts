import { createClient, ClientConfig } from '@webpieces/http-client';
import { SaveApiPrototype } from '../src/api/SaveApi';
import { SaveRequest } from '../src/api/SaveRequest';
import { SaveResponse } from '../src/api/SaveResponse';

describe('SaveApi HTTP Client Tests', () => {
    let mockFetch: jest.Mock;
    let originalFetch: typeof fetch;

    beforeEach(() => {
        // Save original fetch and create a mock
        originalFetch = global.fetch;
        mockFetch = jest.fn();
        global.fetch = mockFetch as any;
    });

    afterEach(() => {
        // Restore original fetch
        global.fetch = originalFetch;
    });

    it('should create a client from API prototype', () => {
        const config = new ClientConfig('http://localhost:3000');
        const client = createClient(SaveApiPrototype, config);

        expect(client).toBeDefined();
        expect(typeof client.save).toBe('function');
    });

    it('should make POST request to correct path', async () => {
        // Mock successful response
        const mockResponse: SaveResponse = {
            success: true,
            searchTime: 10,
            matches: [
                {
                    title: 'Test Result',
                    description: 'Mock description',
                    score: 100,
                },
            ],
        };

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        // Create client
        const config = new ClientConfig('http://localhost:3000');
        const client = createClient(SaveApiPrototype, config);

        // Make request
        const request: SaveRequest = {
            query: 'test query',
        };

        const response = await client.save(request);

        // Verify fetch was called correctly
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/search/item', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });

        // Verify response
        expect(response).toEqual(mockResponse);
        expect(response.success).toBe(true);
        expect(response.matches).toHaveLength(1);
    });

    it('should throw error on HTTP error response', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'Server error details',
        });

        const config = new ClientConfig('http://localhost:3000');
        const client = createClient(SaveApiPrototype, config);

        await expect(client.save({ query: 'test' })).rejects.toThrow(
            'HTTP 500: Internal Server Error',
        );
    });

    it('should be type-safe and match server API', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                success: true,
                searchTime: 15,
                matches: [],
            }),
        });

        const config = new ClientConfig('http://localhost:3000');
        const client = createClient(SaveApiPrototype, config);

        // TypeScript should enforce correct types
        const request: SaveRequest = {
            query: 'my search',
            meta: {
                source: 'client-test',
            },
        };

        const response: SaveResponse = await client.save(request);

        // Response should have correct type
        expect(response.success).toBeDefined();
        expect(response.searchTime).toBeDefined();
        expect(response.matches).toBeDefined();
    });

    it('should throw error if API prototype is not decorated with @ApiInterface', () => {
        class InvalidApi {
            save(request: SaveRequest): Promise<SaveResponse> {
                throw new Error('Not implemented');
            }
        }

        expect(() => {
            const config = new ClientConfig('http://localhost:3000');
            createClient(InvalidApi as any, config);
        }).toThrow('must be decorated with @ApiInterface()');
    });
});
