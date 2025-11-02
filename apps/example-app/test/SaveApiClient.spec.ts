import { createClient } from '@webpieces/http-client';
import { SaveApiPrototype } from '../src/api/SaveApi';
import { SaveRequest } from '../src/api/SaveRequest';
import { SaveResponse } from '../src/api/SaveResponse';

describe('SaveApi HTTP Client Tests', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    // Create a mock fetch function
    mockFetch = jest.fn();
  });

  it('should create a client from API prototype', () => {
    const client = createClient(SaveApiPrototype, {
      baseUrl: 'http://localhost:3000',
      fetch: mockFetch,
    });

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
    const client = createClient(SaveApiPrototype, {
      baseUrl: 'http://localhost:3000',
      fetch: mockFetch,
    });

    // Make request
    const request: SaveRequest = {
      query: 'test query',
    };

    const response = await client.save(request);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/search/item',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }
    );

    // Verify response
    expect(response).toEqual(mockResponse);
    expect(response.success).toBe(true);
    expect(response.matches).toHaveLength(1);
  });

  it('should include custom headers in request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, searchTime: 5, matches: [] }),
    });

    const client = createClient(SaveApiPrototype, {
      baseUrl: 'http://localhost:3000',
      headers: {
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'custom-value',
      },
      fetch: mockFetch,
    });

    await client.save({ query: 'test' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/search/item',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value',
        },
      })
    );
  });

  it('should throw error on HTTP error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error details',
    });

    const client = createClient(SaveApiPrototype, {
      baseUrl: 'http://localhost:3000',
      fetch: mockFetch,
    });

    await expect(client.save({ query: 'test' })).rejects.toThrow(
      'HTTP 500: Internal Server Error'
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

    const client = createClient(SaveApiPrototype, {
      baseUrl: 'http://localhost:3000',
      fetch: mockFetch,
    });

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
      createClient(InvalidApi as any, {
        baseUrl: 'http://localhost:3000',
        fetch: mockFetch,
      });
    }).toThrow('must be decorated with @ApiInterface()');
  });
});
