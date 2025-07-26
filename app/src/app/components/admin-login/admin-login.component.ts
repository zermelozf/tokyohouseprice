import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="admin-login-overlay" (click)="onOverlayClick($event)">
      <div class="admin-login-modal">
        <div class="modal-header">
          <h3 i18n="@@admin.loginTitle">Admin Login</h3>
          <button class="close-btn" (click)="closeModal()" type="button">
            <i class="fas fa-times"></i>
          </button>
        </div>
        
        <div class="google-auth-container">
          <p class="auth-description" i18n="@@admin.googleAuthDescription">
            Sign in with your Google account to access admin features.
          </p>
          
          <button 
            type="button"
            (click)="onGoogleLogin()"
            [disabled]="isLoading"
            class="google-login-btn">
            <i class="fab fa-google"></i>
            <span *ngIf="!isLoading" i18n="@@admin.signInWithGoogle">Sign in with Google</span>
            <span *ngIf="isLoading" i18n="@@admin.signingIn">Signing in...</span>
          </button>
          
          <div class="error-message" *ngIf="errorMessage">
            <p>{{ errorMessage }}</p>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .admin-login-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .admin-login-modal {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      width: 100%;
      max-width: 400px;
      margin: 1rem;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid #eee;
      padding-bottom: 1rem;
    }

    .modal-header h3 {
      margin: 0;
      color: #333;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 1.2rem;
      cursor: pointer;
      color: #666;
      padding: 0.25rem;
    }

    .close-btn:hover {
      color: #333;
    }

    .google-auth-container {
      text-align: center;
    }

    .auth-description {
      margin-bottom: 1.5rem;
      color: #666;
      line-height: 1.5;
    }

    .google-login-btn {
      width: 100%;
      background: #4285f4;
      color: white;
      border: none;
      padding: 0.75rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: background-color 0.2s;
    }

    .google-login-btn:hover:not(:disabled) {
      background: #357ae8;
    }

    .google-login-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .google-login-btn i {
      font-size: 1.1rem;
    }

    .error-message {
      margin-top: 1rem;
      padding: 0.75rem;
      background: #fee;
      border: 1px solid #fcc;
      border-radius: 4px;
      color: #c33;
      font-size: 0.85rem;
    }

    @media (max-width: 500px) {
      .admin-login-modal {
        margin: 0.5rem;
        padding: 1.5rem;
      }
    }
  `]
})
export class AdminLoginComponent {
  @Output() close = new EventEmitter<void>();
  @Output() loginSuccess = new EventEmitter<void>();

  isLoading = false;
  errorMessage = '';

  constructor(private authService: AuthService) {}

  async onGoogleLogin() {
    if (this.isLoading) return;

    this.isLoading = true;
    this.errorMessage = '';

    try {
      await this.authService.signInWithGoogle();
      this.loginSuccess.emit();
      this.closeModal();
    } catch (error: any) {
      this.errorMessage = this.getErrorMessage(error);
    } finally {
      this.isLoading = false;
    }
  }

  private getErrorMessage(error: any): string {
    switch (error.code) {
      case 'auth/popup-closed-by-user':
        return 'Sign-in was cancelled. Please try again.';
      case 'auth/popup-blocked':
        return 'Popup was blocked by your browser. Please allow popups and try again.';
      case 'auth/cancelled-popup-request':
        return 'Another sign-in request is in progress.';
      case 'auth/network-request-failed':
        return 'Network error. Please check your connection and try again.';
      case 'auth/too-many-requests':
        return 'Too many failed attempts. Please try again later.';
      default:
        return 'Google sign-in failed. Please try again.';
    }
  }

  closeModal() {
    this.close.emit();
  }

  onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.closeModal();
    }
  }
} 