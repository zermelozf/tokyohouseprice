import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CommentService, Comment } from '../../services/comment.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-comment-item',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="comment-item">
      <div class="comment-header">
        <div class="comment-author">
          <strong>{{ comment.author }}</strong>
        </div>
        <div class="comment-date">
          {{ formatDate(comment.createdAt) }}
        </div>
      </div>
      
      <div class="comment-content">
        <p>{{ comment.content }}</p>
      </div>
      
             <div class="comment-actions">
         <button 
           class="like-btn" 
           (click)="onToggleLike()"
           [class.liked]="isLikedByCurrentUser()"
           [disabled]="isLiking"
           type="button">
           <i class="fas fa-heart"></i>
           <span>{{ comment.likes || 0 }}</span>
         </button>
         <button 
           *ngIf="!isReply"
           class="reply-btn" 
           (click)="toggleReplyForm()"
           type="button">
           <i class="fas fa-reply"></i>
           <span i18n="@@comments.reply">Reply</span>
         </button>
       </div>

      <!-- Admin controls -->
      <div class="admin-actions" *ngIf="authService.isAdmin()">
        <button 
          class="delete-btn" 
          (click)="onDeleteComment()"
          type="button"
          [disabled]="isDeleting"
          i18n-title="@@admin.deleteComment"
          title="Delete comment">
          <i class="fas fa-trash"></i>
          <span *ngIf="!isDeleting" i18n="@@admin.delete">Delete</span>
          <span *ngIf="isDeleting" i18n="@@admin.deleting">Deleting...</span>
        </button>
      </div>

      <!-- Reply form (only for top-level comments) -->
      <div class="reply-form" *ngIf="showReplyForm && !isReply">
        <form (ngSubmit)="onSubmitReply()" #replyForm="ngForm">
                     <div class="form-row">
             <div class="form-group" *ngIf="!(authService.user$ | async)">
               <label for="replyAuthor" i18n="@@comments.name">Name *</label>
               <input 
                 type="text" 
                 id="replyAuthor" 
                 name="replyAuthor" 
                 [(ngModel)]="newReply.author" 
                 required 
                 #replyAuthorInput="ngModel"
                 [class.error]="replyAuthorInput.invalid && replyAuthorInput.touched"
                 i18n-placeholder="@@comments.namePlaceholder"
                 placeholder="Enter your name">
             </div>
             <div class="form-group" *ngIf="authService.user$ | async as user">
               <label for="replyAuthorLoggedIn" i18n="@@comments.nameLoggedIn">Name</label>
               <input 
                 type="text" 
                 id="replyAuthorLoggedIn" 
                 name="replyAuthorLoggedIn"
                 [value]="getUserDisplayName(user)" 
                 readonly
                 class="name-readonly">
             </div>
                         <div class="form-group" *ngIf="!(authService.user$ | async)">
               <label for="replyEmail" i18n="@@comments.emailOptional">Email (Optional)</label>
               <input 
                 type="email" 
                 id="replyEmail" 
                 name="replyEmail" 
                 [(ngModel)]="newReply.email" 
                 email 
                 #replyEmailInput="ngModel"
                 [class.error]="replyEmailInput.invalid && replyEmailInput.touched"
                 i18n-placeholder="@@comments.emailOptionalPlaceholder"
                 placeholder="Enter your email (optional)">
             </div>
             <div class="form-group" *ngIf="authService.user$ | async as user">
               <label for="replyEmailLoggedIn" i18n="@@comments.emailLoggedIn">Email</label>
               <input 
                 type="email" 
                 id="replyEmailLoggedIn" 
                 name="replyEmailLoggedIn"
                 [value]="user.email" 
                 readonly
                 class="email-readonly">
             </div>
          </div>
          <div class="form-group">
            <label for="replyContent" i18n="@@comments.reply">Reply *</label>
            <textarea 
              id="replyContent" 
              name="replyContent" 
              [(ngModel)]="newReply.content" 
              required 
              #replyContentInput="ngModel"
              [class.error]="replyContentInput.invalid && replyContentInput.touched"
              rows="3"
              i18n-placeholder="@@comments.replyPlaceholder"
              placeholder="Write your reply..."></textarea>
          </div>
          <div class="reply-actions">
            <button 
              type="submit" 
              [disabled]="!replyForm.valid || isSubmittingReply"
              class="submit-reply-btn">
              <span *ngIf="!isSubmittingReply" i18n="@@comments.postReply">Post Reply</span>
              <span *ngIf="isSubmittingReply" i18n="@@comments.posting">Posting...</span>
            </button>
            <button 
              type="button" 
              (click)="cancelReply()"
              class="cancel-btn"
              i18n="@@comments.cancel">Cancel</button>
          </div>
        </form>
      </div>

      <!-- Nested replies -->
      <div class="replies" *ngIf="comment.replies && comment.replies.length > 0">
        <div *ngFor="let reply of comment.replies" class="reply-item">
          <app-comment-item 
            [comment]="reply" 
            [articleId]="articleId"
            [isReply]="true"
            (replyAdded)="onReplyAdded()">
          </app-comment-item>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .comment-item {
      padding: 1.5rem;
      border-bottom: 1px solid #eee;
    }

    .comment-item:last-child {
      border-bottom: none;
    }

    .comment-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .comment-author {
      font-size: 0.95rem;
      color: #333;
    }

    .comment-date {
      font-size: 0.8rem;
      color: #666;
    }

    .comment-content {
      margin-bottom: 1rem;
      line-height: 1.6;
    }

    .comment-content p {
      margin: 0;
      color: #444;
    }

    .comment-actions {
      margin-bottom: 1rem;
      display: flex;
      gap: 1rem;
      align-items: center;
    }

    .admin-actions {
      margin-bottom: 1rem;
    }

    .delete-btn {
      background: #dc3545;
      color: white;
      border: none;
      cursor: pointer;
      font-size: 0.8rem;
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.4rem 0.6rem;
      border-radius: 3px;
      transition: background-color 0.2s;
    }

    .delete-btn:hover:not(:disabled) {
      background: #c82333;
    }

    .delete-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .reply-btn {
      background: none;
      border: none;
      color: #FF69B4;
      cursor: pointer;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.25rem 0;
      transition: color 0.2s;
    }

    .reply-btn:hover {
      color: #e55aa0;
    }

    .reply-form {
      background: #f5f5f5;
      padding: 1rem;
      border-radius: 6px;
      margin: 1rem 0;
      border-left: 3px solid #FF69B4;
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
      margin-bottom: 0.4rem;
      font-weight: 500;
      color: #333;
      font-size: 0.85rem;
    }

    .form-group input,
    .form-group textarea {
      width: 100%;
      padding: 0.6rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 0.85rem;
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

    .email-readonly,
    .name-readonly {
      background-color: #f8f9fa !important;
      color: #6c757d !important;
      cursor: not-allowed !important;
    }

    .like-btn {
      background: none;
      border: none;
      color: #6c757d;
      cursor: pointer;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      transition: all 0.2s;
    }

    .like-btn:hover:not(:disabled) {
      background: #f8f9fa;
      color: #e91e63;
    }

    .like-btn.liked {
      color: #e91e63;
    }

    .like-btn.liked i {
      animation: heartPulse 0.3s ease-in-out;
    }

    .like-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    @keyframes heartPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.2); }
      100% { transform: scale(1); }
    }

    .reply-actions {
      display: flex;
      gap: 0.75rem;
    }

    .submit-reply-btn {
      background: #FF69B4;
      color: white;
      border: none;
      padding: 0.6rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      transition: background-color 0.2s;
    }

    .submit-reply-btn:hover:not(:disabled) {
      background: #e55aa0;
    }

    .submit-reply-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .cancel-btn {
      background: #f5f5f5;
      color: #666;
      border: 1px solid #ddd;
      padding: 0.6rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.2s;
    }

    .cancel-btn:hover {
      background: #eee;
      color: #333;
    }

    .replies {
      margin-top: 1rem;
      border-left: 2px solid #e0e0e0;
      margin-left: 1rem;
    }

    .reply-item {
      background: #fafafa;
    }

    .reply-item .comment-item {
      padding: 1rem;
      border-bottom: 1px solid #e8e8e8;
    }

    .reply-item:last-child .comment-item {
      border-bottom: none;
    }

    @media (max-width: 768px) {
      .comment-item {
        padding: 1rem;
      }

      .form-row {
        flex-direction: column;
        gap: 0;
      }

      .reply-form {
        padding: 0.75rem;
      }

      .replies {
        margin-left: 0.5rem;
      }
    }
  `]
})
export class CommentItemComponent {
  @Input() comment!: Comment;
  @Input() articleId!: string;
  @Input() isReply = false;
  @Output() replyAdded = new EventEmitter<void>();

  showReplyForm = false;
  isSubmittingReply = false;
  isDeleting = false;
  isLiking = false;

  newReply = {
    author: '',
    email: '',
    content: ''
  };

  constructor(
    private commentService: CommentService,
    public authService: AuthService
  ) {}

  toggleReplyForm() {
    this.showReplyForm = !this.showReplyForm;
    if (!this.showReplyForm) {
      this.resetReplyForm();
    }
  }

  cancelReply() {
    this.showReplyForm = false;
    this.resetReplyForm();
  }

  resetReplyForm() {
    this.newReply = {
      author: '',
      email: '',
      content: ''
    };
  }

  async onSubmitReply() {
    if (this.isSubmittingReply || this.isReply) return; // Only top-level comments can receive replies

    this.isSubmittingReply = true;
    try {
      const currentUser = this.authService.getCurrentUser();
      const emailToUse = currentUser?.email || this.newReply.email;
      const authorToUse = currentUser ? this.getUserDisplayName(currentUser) : this.newReply.author;

      await this.commentService.addComment({
        articleId: this.articleId,
        parentCommentId: this.comment.id,
        author: authorToUse,
        email: emailToUse,
        content: this.newReply.content
      });

      this.resetReplyForm();
      this.showReplyForm = false;
      this.replyAdded.emit();
    } catch (error) {
      console.error('Error adding reply:', error);
    } finally {
      this.isSubmittingReply = false;
    }
  }

  getUserDisplayName(user: any): string {
    return user.displayName || user.email?.split('@')[0] || 'User';
  }

  onReplyAdded() {
    this.replyAdded.emit();
  }

  async onDeleteComment() {
    if (this.isDeleting) return;

    const confirmed = confirm('Are you sure you want to delete this comment? This action cannot be undone.');
    if (!confirmed) return;

    this.isDeleting = true;
    try {
      if (this.comment.replies && this.comment.replies.length > 0) {
        // Delete comment and all its replies
        await this.commentService.deleteCommentAndReplies(this.comment.id!);
      } else {
        // Delete just this comment
        await this.commentService.deleteComment(this.comment.id!);
      }
      
      this.replyAdded.emit(); // Refresh the comments list
    } catch (error) {
      console.error('Error deleting comment:', error);
      alert('Failed to delete comment. Please try again.');
    } finally {
      this.isDeleting = false;
    }
  }

  async onToggleLike() {
    if (this.isLiking) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser?.email) {
      alert('Please login to like comments');
      return;
    }

    this.isLiking = true;
    try {
      const isLiked = this.isLikedByCurrentUser();
      
      if (isLiked) {
        await this.commentService.unlikeComment(this.comment.id!, currentUser.email);
      } else {
        await this.commentService.likeComment(this.comment.id!, currentUser.email);
      }
      
      this.replyAdded.emit(); // Refresh the comments to show updated likes
    } catch (error) {
      console.error('Error toggling like:', error);
    } finally {
      this.isLiking = false;
    }
  }

  isLikedByCurrentUser(): boolean {
    const currentUser = this.authService.getCurrentUser();
    return this.commentService.hasUserLiked(this.comment, currentUser?.email || null);
  }

  formatDate(timestamp: any): string {
    if (!timestamp) return '';
    
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return 'Just now';
    } else if (diffMins < 60) {
      return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  }
} 