import { inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { Auth, idToken } from '@angular/fire/auth';
import { from, of, switchMap, take } from 'rxjs';

import { environment } from '../../environments/environment';

/**
 * Attach the Firebase ID token to scraper API calls.
 *
 * The token is fetched per request rather than cached, because Firebase
 * refreshes it roughly hourly and `getIdToken()` hands back the current one —
 * a copy kept at sign-in would start returning 401s an hour into a session.
 *
 * Only scraper requests get it. The public endpoints (price model, articles)
 * need no identity, and sending one to a third-party host would leak it.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const forScraper = req.url.startsWith(environment.scraperApiUrl);
  if (!forScraper) return next(req);

  const auth = inject(Auth);
  const user = auth.currentUser;
  if (!user) return next(req);          // unauthenticated: the API answers 401

  return from(user.getIdToken()).pipe(
    take(1),
    switchMap(token => next(req.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
    }))),
  );
};
