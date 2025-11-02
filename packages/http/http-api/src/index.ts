/**
 * @webpieces/http-api
 *
 * Core HTTP API definition package.
 * Contains decorators and utilities for defining HTTP APIs.
 *
 * This package is used by:
 * - @webpieces/http-routing (server-side): Routes HTTP requests to controllers
 * - @webpieces/http-client (client-side): Generates HTTP clients from API definitions
 *
 * Architecture:
 * ```
 * http-api (defines the contract)
 *    ↑
 *    ├── http-routing (server: contract → handlers)
 *    └── http-client (client: contract → HTTP requests)
 * ```
 */

// API definition decorators
export {
  ApiInterface,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Path,
  getRoutes,
  isApiInterface,
  RouteMetadata,
  METADATA_KEYS,
} from './decorators';

// Type validators
export { ValidateImplementation } from './validators';
