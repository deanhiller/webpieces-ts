import { bootstrapApplication } from '@angular/platform-browser';
import { CompanyHeaders } from '@webpieces/company-core';
import { LogManager, HeaderRegistry, ConsoleLoggerFactory } from '@webpieces/core-util';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

// Register the global HeaderRegistry FIRST (this browser app has no server-specific
// keys of its own — just the shared company keys + platform defaults), then install
// the logging backend. LogManager.setFactory fails fast if the registry is unset.
HeaderRegistry.configure(CompanyHeaders.getAllHeaders(), /*platformHeaders*/ true);

// Install the logging backend (browser-safe console) before bootstrap.
LogManager.setFactory(new ConsoleLoggerFactory());

const log = LogManager.getLogger('main');

bootstrapApplication(AppComponent, appConfig)
  .catch(err => log.error('bootstrap failed', err));
