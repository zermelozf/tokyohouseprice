import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../environments/environment';

declare global {
  interface Window {
    grecaptcha: any;
  }
}

@Injectable({
  providedIn: 'root'
})
export class RecaptchaService {
  private isRecaptchaLoaded = false;
  private recaptchaPromise: Promise<void> | null = null;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {}

  loadRecaptcha(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return Promise.resolve();
    }

    if (this.recaptchaPromise) {
      return this.recaptchaPromise;
    }

    if (this.isRecaptchaLoaded) {
      return Promise.resolve();
    }

    this.recaptchaPromise = new Promise((resolve, reject) => {
      if (typeof window.grecaptcha !== 'undefined') {
        this.isRecaptchaLoaded = true;
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?render=${environment.recaptcha.siteKey}`;
      script.async = true;
      script.defer = true;
      
      script.onload = () => {
        window.grecaptcha.ready(() => {
          this.isRecaptchaLoaded = true;
          resolve();
        });
      };
      
      script.onerror = (error) => {
        console.error('Failed to load reCAPTCHA script:', error);
        reject(error);
      };

      document.head.appendChild(script);
    });

    return this.recaptchaPromise;
  }

  async executeRecaptcha(action: string = 'submit'): Promise<string> {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('reCAPTCHA can only be executed in browser environment');
    }

    await this.loadRecaptcha();

    return new Promise((resolve, reject) => {
      if (!window.grecaptcha) {
        reject(new Error('reCAPTCHA not loaded'));
        return;
      }

      window.grecaptcha.ready(() => {
        window.grecaptcha.execute(environment.recaptcha.siteKey, { action })
          .then((token: string) => {
            resolve(token);
          })
          .catch((error: any) => {
            console.error('reCAPTCHA execution failed:', error);
            reject(error);
          });
      });
    });
  }

  async getToken(action: string = 'comment'): Promise<string> {
    try {
      return await this.executeRecaptcha(action);
    } catch (error) {
      console.error('Failed to get reCAPTCHA token:', error);
      throw new Error('reCAPTCHA verification failed. Please try again.');
    }
  }
} 