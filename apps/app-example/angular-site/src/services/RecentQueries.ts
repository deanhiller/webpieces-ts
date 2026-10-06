import { Injectable } from '@angular/core';
import { BrowserStorageApi } from '@webpieces/browser-storage-api';

const LAST_QUERY = 'webpieces.example.lastQuery';

/**
 * The production business consumer of the {@link BrowserStorageApi} vendor seam: remembers the last
 * query the user saved. It depends on the CONTRACT only — which vendor implements it is wiring.ts's
 * decision — and that constructor dependency is what proves the app's `uses / external` edge.
 */
@Injectable({
  providedIn: 'root'
})
export class RecentQueries {
  constructor(private readonly storage: BrowserStorageApi) {}

  remember(query: string): void {
    this.storage.write(LAST_QUERY, query);
  }

  last(): string | undefined {
    return this.storage.read(LAST_QUERY);
  }
}
