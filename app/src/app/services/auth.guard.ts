import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
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
  const router = inject(Router);
  // Redirect rather than return false: refusing a direct visit to /scraper
  // cancels the navigation, which on a fresh load leaves an empty page with no
  // way out. Sending them home at least lands somewhere with a sign-in button.
  return authState(auth).pipe(
    take(1),
    map(user => user ? true : router.parseUrl('/')),
  );
};
