import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CommentService, Comment } from '../../services/comment.service';
import { CommentItemComponent } from '../comment-item/comment-item.component';
import { AdminLoginComponent } from '../admin-login/admin-login.component';
import { AuthService } from '../../services/auth.service';
import { Observable } from 'rxjs';

@Component({
  selector: 'app-comments',
  standalone: true,
  imports: [CommonModule, FormsModule, CommentItemComponent, AdminLoginComponent],
  template: `
    <div class="comments-section">
      <div class="comments-header">
        <h2 i18n="@@comments.title">Comments</h2>
        <div class="header-actions">
          <div class="comments-count" *ngIf="commentsCount > 0">
            <span i18n="@@comments.count">{{ commentsCount }} comment{{ commentsCount > 1 ? 's' : '' }}</span>
          </div>
          <div class="admin-controls">
            <button 
              *ngIf="!(authService.user$ | async) && !showAdminLogin" 
              class="login-btn" 
              (click)="showAdminLogin = true"
              i18n="@@auth.login">
              Login
            </button>
            <div *ngIf="authService.user$ | async as user" class="user-info">
              <span class="user-greeting">{{ user.email }}</span>
              <button class="logout-btn" (click)="onLogout()" i18n="@@auth.logout">Logout</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Add new comment form -->
      <div class="add-comment-form">
        <h3 i18n="@@comments.addComment">Add a Comment</h3>
        <form (ngSubmit)="onSubmitComment()" #commentForm="ngForm">
          <div class="form-row">
            <div class="form-group">
              <label for="author" i18n="@@comments.name">Name *</label>
              <input 
                type="text" 
                id="author" 
                name="author" 
                [(ngModel)]="newComment.author" 
                required 
                #authorInput="ngModel"
                [class.error]="authorInput.invalid && authorInput.touched"
                i18n-placeholder="@@comments.namePlaceholder"
                placeholder="Enter your name">
            </div>
                         <div class="form-group" *ngIf="!(authService.user$ | async)">
               <label for="email" i18n="@@comments.emailOptional">Email (Optional)</label>
               <input 
                 type="email" 
                 id="email" 
                 name="email" 
                 [(ngModel)]="newComment.email" 
                 email 
                 #emailInput="ngModel"
                 [class.error]="emailInput.invalid && emailInput.touched"
                 i18n-placeholder="@@comments.emailOptionalPlaceholder"
                 placeholder="Enter your email (optional)">
             </div>
             <div class="form-group" *ngIf="authService.user$ | async as user">
               <label for="emailLoggedIn" i18n="@@comments.emailLoggedIn">Email</label>
               <input 
                 type="email" 
                 id="emailLoggedIn" 
                 name="emailLoggedIn"
                 [value]="user.email" 
                 readonly
                 class="email-readonly">
             </div>
          </div>
          <div class="form-group">
            <label for="content" i18n="@@comments.comment">Comment *</label>
            <textarea 
              id="content" 
              name="content" 
              [(ngModel)]="newComment.content" 
              required 
              #contentInput="ngModel"
              [class.error]="contentInput.invalid && contentInput.touched"
              rows="4"
              i18n-placeholder="@@comments.commentPlaceholder"
              placeholder="Share your thoughts..."></textarea>
          </div>
          <button 
            type="submit" 
            [disabled]="!commentForm.valid || isSubmitting"
            class="submit-btn">
            <span *ngIf="!isSubmitting" i18n="@@comments.postComment">Post Comment</span>
            <span *ngIf="isSubmitting" i18n="@@comments.posting">Posting...</span>
          </button>
        </form>
      </div>

      <!-- Comments list -->
      <div class="comments-list" *ngIf="comments$ | async as comments">
        <div *ngIf="comments.length === 0" class="no-comments">
          <p i18n="@@comments.noComments">Be the first to comment!</p>
        </div>
        <div *ngFor="let comment of comments" class="comment-thread">
          <app-comment-item 
            [comment]="comment" 
            [articleId]="articleId"
            (replyAdded)="onReplyAdded()">
          </app-comment-item>
        </div>
      </div>

      <!-- Loading state -->
      <div *ngIf="isLoading" class="loading">
        <p i18n="@@comments.loading">Loading comments...</p>
      </div>
    </div>

    <!-- Admin Login Modal -->
    <app-admin-login 
      *ngIf="showAdminLogin" 
      (close)="onAdminLoginClose()"
      (loginSuccess)="onAdminLoginSuccess()">
    </app-admin-login>
  `,
  styles: [`
    .comments-section {
      margin: 3rem 0;
      padding: 2rem;
      background: #f9f9f9;
      border-radius: 8px;
    }

    .comments-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      border-bottom: 2px solid #e0e0e0;
      padding-bottom: 1rem;
    }

    .comments-header h2 {
      margin: 0;
      color: #333;
      font-size: 1.8rem;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .comments-count {
      color: #666;
      font-size: 0.9rem;
    }

    .admin-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .login-btn {
      background: #007bff;
      color: white;
      border: none;
      padding: 0.4rem 0.8rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      transition: background-color 0.2s;
    }

    .login-btn:hover {
      background: #0056b3;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .user-greeting {
      font-size: 0.8rem;
      color: #28a745;
      font-weight: 500;
    }

    .logout-btn {
      background: #dc3545;
      color: white;
      border: none;
      padding: 0.3rem 0.6rem;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: background-color 0.2s;
    }

    .logout-btn:hover {
      background: #c82333;
    }

    .add-comment-form {
      background: white;
      padding: 1.5rem;
      border-radius: 8px;
      margin-bottom: 2rem;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .add-comment-form h3 {
      margin: 0 0 1rem 0;
      color: #333;
      font-size: 1.2rem;
    }

    .form-row {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .form-group {
      flex: 1;
    }

    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      color: #333;
    }

    .form-group input,
    .form-group textarea {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 0.9rem;
      transition: border-color 0.2s;
    }

    .form-group input:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: #FF69B4;
      box-shadow: 0 0 0 2px rgba(255, 105, 180, 0.1);
    }

    .form-group input.error,
    .form-group textarea.error {
      border-color: #e74c3c;
    }

    .email-readonly {
      background-color: #f8f9fa !important;
      color: #6c757d !important;
      cursor: not-allowed !important;
    }

    .submit-btn {
      background: #FF69B4;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      transition: background-color 0.2s;
    }

    .submit-btn:hover:not(:disabled) {
      background: #e55aa0;
    }

    .submit-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .comments-list {
      background: white;
      border-radius: 8px;
      overflow: hidden;
    }

    .comment-thread {
      border-bottom: 1px solid #eee;
    }

    .comment-thread:last-child {
      border-bottom: none;
    }

    .no-comments {
      text-align: center;
      padding: 3rem;
      color: #666;
    }

    .loading {
      text-align: center;
      padding: 2rem;
      color: #666;
    }

    @media (max-width: 768px) {
      .comments-section {
        padding: 1rem;
        margin: 2rem 0;
      }

      .form-row {
        flex-direction: column;
        gap: 0;
      }

      .add-comment-form {
        padding: 1rem;
      }
    }
  `]
})
export class CommentsComponent implements OnInit {
  @Input() articleId!: string;

  comments$!: Observable<Comment[]>;
  commentsCount = 0;
  isLoading = true;
  isSubmitting = false;
  showAdminLogin = false;

  newComment = {
    author: '',
    email: '',
    content: ''
  };

  constructor(
    private commentService: CommentService,
    public authService: AuthService
  ) {}

  ngOnInit() {
    this.loadComments();
    this.loadCommentsCount();
  }

  loadComments() {
    this.isLoading = true;
    this.comments$ = this.commentService.getCommentsForArticle(this.articleId);
    this.comments$.subscribe(() => {
      this.isLoading = false;
    });
  }

  async loadCommentsCount() {
    this.commentsCount = await this.commentService.getCommentsCount(this.articleId);
  }

  async onSubmitComment() {
    if (this.isSubmitting) return;

    this.isSubmitting = true;
    try {
      const currentUser = this.authService.getCurrentUser();
      const emailToUse = currentUser?.email || this.newComment.email;

      await this.commentService.addComment({
        articleId: this.articleId,
        author: this.newComment.author,
        email: emailToUse,
        content: this.newComment.content
      });

      // Reset form
      this.newComment = {
        author: '',
        email: '',
        content: ''
      };

      // Reload comments
      this.loadComments();
      this.loadCommentsCount();
    } catch (error) {
      console.error('Error adding comment:', error);
    } finally {
      this.isSubmitting = false;
    }
  }

  onReplyAdded() {
    this.loadComments();
    this.loadCommentsCount();
  }

  async onLogout() {
    try {
      await this.authService.signOut();
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  onAdminLoginClose() {
    this.showAdminLogin = false;
  }

  onAdminLoginSuccess() {
    this.showAdminLogin = false;
    // Refresh comments to show admin controls
    this.loadComments();
  }
} 