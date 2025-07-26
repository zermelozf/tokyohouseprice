import { Injectable } from '@angular/core';
import { Auth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from '@angular/fire/auth';
import { Observable, BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private userSubject = new BehaviorSubject<User | null>(null);
  public user$ = this.userSubject.asObservable();
  
  private readonly ADMIN_EMAIL = 'arnaud@linalgo.com';

  constructor(private auth: Auth) {
    // Listen to auth state changes
    onAuthStateChanged(this.auth, (user) => {
      this.userSubject.next(user);
    });
  }

  // Sign in with Google
  async signInWithGoogle(): Promise<void> {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(this.auth, provider);
    } catch (error) {
      console.error('Google sign in error:', error);
      throw error;
    }
  }

  // Sign out
  async signOut(): Promise<void> {
    try {
      await signOut(this.auth);
    } catch (error) {
      console.error('Sign out error:', error);
      throw error;
    }
  }

  // Check if current user is admin
  isAdmin(): boolean {
    const user = this.userSubject.value;
    return user?.email === this.ADMIN_EMAIL;
  }

  // Get current user
  getCurrentUser(): User | null {
    return this.userSubject.value;
  }

  // Check if user is authenticated
  isAuthenticated(): boolean {
    return this.userSubject.value !== null;
  }

  // Get admin email for comparison
  getAdminEmail(): string {
    return this.ADMIN_EMAIL;
  }
} 