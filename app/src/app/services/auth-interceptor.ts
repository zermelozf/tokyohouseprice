import { inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { Auth, authState } from '@angular/fire/auth';
import { from, of, switchMap, take } from 'rxjs';

import { environment } from '../../environments/environment';

/**
 * Attach the Firebase ID token to scraper API calls.
 *
 * Waits for the first auth state rather than reading `currentUser`. On a page
 * reload Firebase restores the session asynchronously, so `currentUser` is null
 * for a moment — long enough for the dashboard's opening requests to go out
 * bare and come back 401, which reads on screen as "the API is offline".
 *
 * The token is fetched per request rather than cached: Firebase refreshes it
 * roughly hourly and `getIdToken()` returns the current one, so a copy kept at
 * sign-in would start failing an hour into a session.
 *
 * Only scraper requests get it. The public endpoints (price model, articles)
 * need no identity, and sending a token to a third-party host would leak it.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.scraperApiUrl)) return next(req);

  const auth = inject(Auth);
  return authState(auth).pipe(
    take(1),
    switchMap(user => user ? from(user.getIdToken()) : of(null)),
    switchMap(token => next(token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req)),                            // signed out: the API answers 401
  );
};
