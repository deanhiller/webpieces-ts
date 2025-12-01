# @webpieces/server

Umbrella package for WebPieces server-side development. This package installs all necessary dependencies for building WebPieces server applications.

## Installation

```bash
npm install @webpieces/server
```

## What's Included

This package installs:

- `@webpieces/http-server` - WebPieces server with filter chain and DI
- `@webpieces/http-routing` - Decorator-based routing with auto-wiring
- `@webpieces/http-filters` - Filter chain infrastructure
- `@webpieces/http-api` - HTTP API decorators for REST APIs
- `@webpieces/core-meta` - Core metadata interfaces
- `@webpieces/core-context` - AsyncLocalStorage-based context management
- `@webpieces/core-util` - Utility functions

## Usage

After installation, import from the constituent packages:

```typescript
import { WebpiecesServer } from '@webpieces/http-server';
import { Controller, provideSingleton } from '@webpieces/http-routing';
import { WebAppMeta } from '@webpieces/core-meta';

// Your server code here...
```

## Version Compatibility

All @webpieces packages use lock-step versioning. Always use matching versions:

```json
{
  "dependencies": {
    "@webpieces/server": "0.2.10"
  }
}
```

## License

Apache-2.0
