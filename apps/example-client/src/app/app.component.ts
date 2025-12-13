import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import {
  SaveApiPrototype,
  PublicApiPrototype,
  SaveRequest,
  PublicInfoRequest
} from '@webpieces/example-apis';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { toError } from '@webpieces/core-util';

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
  private saveApi = inject(SaveApiPrototype);
  private publicApi = inject(PublicApiPrototype);
  public envConfig = inject(EnvironmentConfig); // Public for template access

  title = 'WebPieces Example Client';
  apiBaseUrl = '';
  saveResponse: any = null;
  publicResponse: any = null;
  loading = false;
  error: string | null = null;

  ngOnInit() {
    this.apiBaseUrl = this.envConfig.apiBaseUrl();
  }

  async callSaveApi() {
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
    } catch (err: any) {
      const error = toError(err);
      this.error = error.message || 'Failed to call SaveApi';
      console.error('SaveApi error:', error);
    } finally {
      this.loading = false;
    }
  }

  async callPublicApi() {
    this.loading = true;
    this.error = null;
    this.publicResponse = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
      const request: PublicInfoRequest = {
        name: 'WebPieces User'
      };

      this.publicResponse = await this.publicApi.getInfo(request);
    } catch (err: any) {
      const error = toError(err);
      this.error = error.message || 'Failed to call PublicApi';
      console.error('PublicApi error:', error);
    } finally {
      this.loading = false;
    }
  }
}
