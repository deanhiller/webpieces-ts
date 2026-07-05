import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import {
  SaveApi,
  PublicApi,
  SaveRequest,
  SaveResponse,
  PublicInfoRequest,
  PublicInfoResponse
} from '@webpieces/client-server-api';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { toError } from '@webpieces/core-util';
import { LogManager } from '@webpieces/wp-logging';

const log = LogManager.getLogger('AppComponent');

/**
 * Root application component.
 * Demonstrates calling both SaveApi and PublicApi using generated HTTP clients.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  // Inject API clients and environment config
  private saveApi = inject(SaveApi);
  private publicApi = inject(PublicApi);
  public envConfig = inject(EnvironmentConfig); // Public for template access

  title = 'WebPieces Example Client';
  apiBaseUrl = '';
  saveResponse: SaveResponse | null = null;
  publicResponse: PublicInfoResponse | null = null;
  loading = false;
  error: string | null = null;

  ngOnInit(): void {
    this.apiBaseUrl = this.envConfig.apiBaseUrl();
  }

  async callSaveApi(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.saveResponse = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
      const request: SaveRequest = {
        query: 'test search from client',
        items: [
          {
            id: 1,
            name: 'Item 1',
            quantity: 10,
            subItem: { thename: 'SubItem A', count: 5 }
          }
        ],
        meta: {
          source: 'angular-client',
          priority: 1
        }
      };

      this.saveResponse = await this.saveApi.save(request);
    } catch (err: unknown) {
      const error = toError(err);
      this.error = error.message || 'Failed to call SaveApi';
      log.error('SaveApi error:', error);
    } finally {
      this.loading = false;
    }
  }

  async callPublicApi(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.publicResponse = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
      const request: PublicInfoRequest = {
        name: 'WebPieces User'
      };

      this.publicResponse = await this.publicApi.getInfo(request);
    } catch (err: unknown) {
      const error = toError(err);
      this.error = error.message || 'Failed to call PublicApi';
      log.error('PublicApi error:', error);
    } finally {
      this.loading = false;
    }
  }
}
