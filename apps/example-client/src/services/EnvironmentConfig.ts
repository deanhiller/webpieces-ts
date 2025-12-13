import { Injectable } from '@angular/core';

/**
 * Environment configuration service.
 * Provides dynamic configuration based on runtime environment.
 *
 * Port calculation pattern:
 * - Repo webpieces-ts (N=0): client on 4200, server on 8200
 * - Repo webpieces-ts1 (N=1): client on 4201, server on 8201
 * - Formula: serverPort = clientPort + 4000
 */
@Injectable({
  providedIn: 'root'
})
export class EnvironmentConfig {
  /**
   * Detects if running in cloud (production) or localhost.
   */
  isCloud(): boolean {
    return !window.location.hostname.includes('localhost');
  }

  /**
   * Returns the base URL of the current web page.
   */
  webBaseUrl(): string {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;

    if (port) {
      return `${protocol}//${hostname}:${port}`;
    }
    return `${protocol}//${hostname}`;
  }

  /**
   * Calculates API base URL dynamically.
   *
   * Uses port-based calculation:
   * - Client port (from window.location.port or default 4200)
   * - Server port = client port + 4000
   *
   * Examples:
   * - Client on 4200 → Server on 8200
   * - Client on 4201 → Server on 8201
   */
  apiBaseUrl(): string {
    if (this.isCloud()) {
      // In production, assume same host/port
      return this.webBaseUrl();
    }

    // In localhost, calculate server port from client port
    const clientPort = parseInt(window.location.port) || 4200;
    const serverPort = clientPort + 4000;

    return `http://localhost:${serverPort}`;
  }
}
