import { bootstrapApplication } from '@angular/platform-browser';
import { CompanyLogging } from '@webpieces/company-core';
import { LogManager } from '@webpieces/core-util';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

// Install the company logging backend (browser-safe console) before bootstrap.
CompanyLogging.configure();

const log = LogManager.getLogger('main');

bootstrapApplication(AppComponent, appConfig)
  .catch(err => log.error('bootstrap failed', err));
