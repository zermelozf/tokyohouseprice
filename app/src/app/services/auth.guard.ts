import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { Auth, authState } from '@angular/fire/auth';
import { map, take } from 'rxjs';

/**
 * Gate a route on being signed in.
 *
 * This is a convenience, not the protection: the scraper API verifies the
 * token itself, so a hand-rolled request gets a 401 whatever the router does.
 * What the guard buys is not rendering a dashboard that would answer every
 * question with an error.
 *
 * It waits for the first real auth state rather than reading `currentUser`,
 * which is null for a moment on reload while Firebase restores the session —
 * long enough to bounce a signed-in user off their own page.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(Auth);
  return authState(auth).pipe(take(1), map(user => !!user));
};
