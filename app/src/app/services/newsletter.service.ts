import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc, query, where, getDocs, Timestamp } from '@angular/fire/firestore';
import { Observable, from, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

export interface NewsletterSubscription {
  email: string;
  subscribedAt: Timestamp;
  source: string;
  isActive: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class NewsletterService {
  private readonly COLLECTION_NAME = 'newsletter_subscriptions';

  constructor(private firestore: Firestore) {}

  /**
   * Subscribe an email to the newsletter
   */
  subscribe(email: string, source: string = 'rent-or-buy-article'): Observable<string> {
    // Validate email format
    if (!this.isValidEmail(email)) {
      return throwError(() => new Error('Invalid email format'));
    }

    // Check if email already exists, then add if it doesn't
    return from(this.checkIfEmailExists(email)).pipe(
      switchMap(exists => {
        if (exists) {
          throw new Error('Email already subscribed');
        }
        // If email doesn't exist, add it to Firestore
        return from(this.addEmailToFirestore(email, source));
      }),
      map(() => 'Successfully subscribed!'),
      catchError(error => {
        console.error('Newsletter subscription error:', error);
        if (error.message === 'Email already subscribed') {
          return throwError(() => new Error('This email is already subscribed to our newsletter.'));
        }
        return throwError(() => new Error('Failed to subscribe. Please try again later.'));
      })
    );
  }

  /**
   * Check if email already exists in the collection
   */
  private async checkIfEmailExists(email: string): Promise<boolean> {
    try {
      const subscriptionsRef = collection(this.firestore, this.COLLECTION_NAME);
      const q = query(subscriptionsRef, where('email', '==', email.toLowerCase()));
      const querySnapshot = await getDocs(q);
      return !querySnapshot.empty;
    } catch (error) {
      console.error('Error checking email existence:', error);
      return false; // Assume email doesn't exist if we can't check
    }
  }

  /**
   * Add email to Firestore
   */
  private async addEmailToFirestore(email: string, source: string): Promise<void> {
    const subscriptionsRef = collection(this.firestore, this.COLLECTION_NAME);
    
    const subscription: NewsletterSubscription = {
      email: email.toLowerCase().trim(),
      subscribedAt: Timestamp.now(),
      source: source,
      isActive: true
    };

    await addDoc(subscriptionsRef, subscription);
  }

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
} 