import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter, withPreloading, PreloadAllModules } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';
import { registerLocaleData } from '@angular/common';
import localeEn from '@angular/common/locales/en';
import localeJa from '@angular/common/locales/ja';

import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { getAnalytics, provideAnalytics, ScreenTrackingService } from '@angular/fire/analytics';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';

import { routes } from './app.routes';
import { environment } from '../environments/environment';
import { AnalyticsService } from './services/analytics.service';

// Register locale data
registerLocaleData(localeEn, 'en-US');
registerLocaleData(localeJa, 'ja');

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(
      routes, 
      withPreloading(PreloadAllModules)
    ),
    provideAnimations(),
    provideHttpClient(),
    provideFirebaseApp(() => initializeApp(environment.firebaseConfig)),
    provideAnalytics(() => getAnalytics()),
    provideFirestore(() => getFirestore()),
    ScreenTrackingService,
    AnalyticsService
  ]
};