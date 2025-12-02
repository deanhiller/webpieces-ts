// @ts-nocheck - Disabled until createApiClient() and getContainer() are implemented
import 'reflect-metadata';
import { WebpiecesServer } from '@webpieces/http-server';
import { ProdServerMeta } from '../src/ProdServerMeta';
import { SaveApi, SaveApiPrototype } from '../src/api/SaveApi';
import { SaveRequest } from '../src/api/SaveRequest';
import { SearchMeta } from '../src/api/SaveRequest';
import { SaveResponse } from '../src/api/SaveResponse';
import { TYPES } from '../src/remote/RemoteApi';

/**
 * Feature tests for SaveApi.
 * Similar to Java TestMicroSvcApi.
 *
 * These tests:
 * 1. Create a WebpiecesServer with ProdServerMeta
 * 2. Get a SaveApi client proxy (NO HTTP involved!)
 * 3. Call save() which goes through:
 *    - ContextFilter (setup context)
 *    - JsonFilter (validate/serialize)
 *    - SaveController (business logic)
 * 4. Verify the response
 *
 * This demonstrates the power of WebPieces: you can test your
 * API without any HTTP overhead, but still go through the full
 * filter stack.
 *
 * TODO: These tests are skipped until createApiClient() and getContainer()
 * are implemented on WebpiecesServer.
 */
describe.skip('SaveApi Feature Tests', () => {
  let server: WebpiecesServer;
  let saveApi: SaveApi;

  beforeEach(() => {
    // Create server with ProdServerMeta
    server = new WebpiecesServer(new ProdServerMeta());

    // Create API client proxy (no HTTP!)
    // This routes calls through filter chain → controller
    saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
  });

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  it('should process save request successfully', async () => {
    // Arrange
    const request = new SaveRequest();
    request.query = 'typescript';

    // Act
    const response = await saveApi.save(request);

    // Assert
    expect(response).toBeDefined();
    expect(response.success).toBe(true);
    expect(response.searchTime).toBe(5);
    expect(response.matches).toHaveLength(1);
    expect(response.matches[0].title).toBe('typescript');
    expect(response.matches[0].score).toBe(100);
  });

  it('should include metadata in matches when provided', async () => {
    // Arrange
    const request = new SaveRequest();
    request.query = 'webpieces';

    const meta = new SearchMeta();
    meta.source = 'github';
    meta.filter = 'typescript';
    request.meta = meta;

    // Act
    const response = await saveApi.save(request);

    // Assert
    expect(response).toBeDefined();
    expect(response.success).toBe(true);
    expect(response.matches).toHaveLength(2); // One from query, one from metadata

    // First match from query
    expect(response.matches[0].title).toBe('webpieces');

    // Second match from metadata
    expect(response.matches[1].title).toContain('github');
  });

  it('should increment counter on each request', async () => {
    // Arrange
    const request1 = new SaveRequest();
    request1.query = 'test1';

    const request2 = new SaveRequest();
    request2.query = 'test2';

    // Act
    await saveApi.save(request1);
    await saveApi.save(request2);

    // Assert
    // We can verify the counter through the DI container
    const container = server.getContainer();
    const counter = container.get<any>(TYPES.Counter);
    expect(counter.get()).toBe(2);
  });

  it('should call remote service for each request', async () => {
    // Arrange
    const request = new SaveRequest();
    request.query = 'remote-test';

    // Act
    const response = await saveApi.save(request);

    // Assert
    // The response should contain data from the remote service
    expect(response.matches[0].description).toContain('Simulated response for: remote-test');
  });
});
