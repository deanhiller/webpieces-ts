import { Injectable } from '@angular/core';
import { BrowserStorageApi } from '@webpieces/browser-storage-api';
import { LogManager } from '@webpieces/core-util';

const log = LogManager.getLogger('LoggedLocalStorage');

/**
 * The vendor implementation of the {@link BrowserStorageApi} seam: window.localStorage, logging every
 * write. It is provided in root under its OWN token, so wiring.ts aliases the contract to it with
 * `binder.bindExternal(BrowserStorageApi, new UseExisting(LoggedLocalStorage))` — both tokens
 * then resolve to this one instance.
 */
@Injectable({
  providedIn: 'root'
})
export class LoggedLocalStorage implements BrowserStorageApi {
  read(key: string): string | undefined {
    return window.localStorage.getItem(key) ?? undefined;
  }

  write(key: string, value: string): void {
    log.info(`localStorage write: ${key}`);
    window.localStorage.setItem(key, value);
  }
}
