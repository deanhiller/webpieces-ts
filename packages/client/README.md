# @webpieces/client

Umbrella package for WebPieces client-side development. This package installs all necessary dependencies for building WebPieces client applications.

## Installation

```bash
npm install @webpieces/client
```

## What's Included

This package installs:

- `@webpieces/http-client` - Type-safe HTTP client generation from API definitions
- `@webpieces/http-api` - HTTP API decorators for REST APIs

## Usage

After installation, import from the constituent packages:

```typescript
import { createApiClient } from '@webpieces/http-client';
import { Post, Get, ApiInterface } from '@webpieces/http-api';

// Your client code here...
```

## Version Compatibility

All @webpieces packages use lock-step versioning. Always use matching versions:

```json
{
  "dependencies": {
    "@webpieces/client": "0.2.10"
  }
}
```

## License

Apache-2.0
