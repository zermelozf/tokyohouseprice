import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CommentService, Comment, CommentSubmission } from '../../services/comment.service';
import { AuthService } from '../../services/auth.service';
import { RecaptchaService } from '../../services/recaptcha.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-comment-item',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './comment-item.component.html',
  styleUrls: ['./comment-item.component.scss']
})
export class CommentItemComponent implements OnInit, OnDestroy {
  @Input() comment!: Comment;
  @Input() articleId!: string;
  @Input() isReply = false;
  @Output() replyAdded = new EventEmitter<void>();

  showReplyForm = false;
  isSubmittingReply = false;
  isDeleting = false;
  isLiking = false;
  isAnimatingLike = false;

  // Pagination for replies
  displayedRepliesCount = 2;
  repliesPerPage = 3;

  // Track pending likes after authentication
  private pendingLike = false;
  private userSubscription?: Subscription;

  newReply = {
    author: '',
    email: '',
    content: ''
  };

  constructor(
    private commentService: CommentService,
    public authService: AuthService,
    private recaptchaService: RecaptchaService
  ) {}

  ngOnInit() {
    // Subscribe to authentication state changes
    this.userSubscription = this.authService.user$.subscribe(user => {
      if (user && this.pendingLike) {
        // User just authenticated and we have a pending like
        this.executePendingLike();
      }
    });
  }

  ngOnDestroy() {
    this.userSubscription?.unsubscribe();
  }

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

      // Get reCAPTCHA token for reply
      let recaptchaToken: string;
      try {
        recaptchaToken = await this.recaptchaService.getToken('reply');
      } catch (error) {
        console.error('reCAPTCHA failed for reply:', error);
        alert('reCAPTCHA verification failed. Please try again.');
        return;
      }

      // Prepare reply submission with reCAPTCHA token
      const submission: CommentSubmission = {
        articleId: this.articleId,
        parentCommentId: this.comment.id,
        author: authorToUse,
        email: emailToUse,
        content: this.newReply.content,
        recaptchaToken: recaptchaToken
      };

      await this.commentService.addComment(submission);

      this.resetReplyForm();
      this.showReplyForm = false;
      this.replyAdded.emit();
    } catch (error) {
      console.error('Error adding reply:', error);
      if (error instanceof Error) {
        alert(error.message);
      } else {
        alert('Failed to add reply. Please try again.');
      }
    } finally {
      this.isSubmittingReply = false;
    }
  }

  async onDeleteComment() {
    if (this.isDeleting) return;

    if (!confirm('Are you sure you want to delete this comment? This action cannot be undone.')) {
      return;
    }

    this.isDeleting = true;
    try {
      if (this.comment.replies && this.comment.replies.length > 0) {
        await this.commentService.deleteCommentAndReplies(this.comment.id!, this.articleId);
      } else {
        await this.commentService.deleteComment(this.comment.id!, this.articleId);
      }
      this.replyAdded.emit(); // Refresh comments
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
      // Trigger authentication popup for non-logged-in users
      await this.authenticateAndLike();
      return;
    }

    await this.performLike(currentUser.email);
  }

  private async authenticateAndLike() {
    try {
      this.pendingLike = true;
      await this.authService.signInWithGoogle();
      // Note: The actual like will be executed in ngOnInit subscription when user authenticates
    } catch (error) {
      console.error('Authentication failed:', error);
      this.pendingLike = false;
      alert('Authentication failed. Please try again.');
    }
  }

  private async executePendingLike() {
    if (!this.pendingLike) return;
    
    this.pendingLike = false;
    const currentUser = this.authService.getCurrentUser();
    
    if (currentUser?.email) {
      await this.performLike(currentUser.email);
    }
  }

  private async performLike(userEmail: string) {
    // Trigger click animation
    this.isAnimatingLike = true;
    setTimeout(() => this.isAnimatingLike = false, 600);

    this.isLiking = true;
    
    const isCurrentlyLiked = this.isLikedByCurrentUser();
    
    // Optimistically update the UI immediately
    if (isCurrentlyLiked) {
      // Remove like
      this.comment.likes = Math.max(0, (this.comment.likes || 0) - 1);
      this.comment.likedBy = (this.comment.likedBy || []).filter(email => email !== userEmail);
    } else {
      // Add like
      this.comment.likes = (this.comment.likes || 0) + 1;
      this.comment.likedBy = [...(this.comment.likedBy || []), userEmail];
    }

    try {
      // Perform the actual API call in the background
      if (isCurrentlyLiked) {
        await this.commentService.unlikeComment(this.comment.id!, userEmail);
      } else {
        await this.commentService.likeComment(this.comment.id!, userEmail);
      }
    } catch (error) {
      console.error('Error toggling like:', error);
      
      // Revert the optimistic update on error
      if (isCurrentlyLiked) {
        // Restore the like
        this.comment.likes = (this.comment.likes || 0) + 1;
        this.comment.likedBy = [...(this.comment.likedBy || []), userEmail];
      } else {
        // Remove the like
        this.comment.likes = Math.max(0, (this.comment.likes || 0) - 1);
        this.comment.likedBy = (this.comment.likedBy || []).filter(email => email !== userEmail);
      }
      
      // Show error message to user
      alert('Failed to update like. Please try again.');
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
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  }

  getUserDisplayName(user: any): string {
    // Check for saved custom display name
    if (user?.email) {
      const saved = localStorage.getItem(`customDisplayName_${user.email}`);
      if (saved && saved.trim()) {
        return saved.trim();
      }
    }
    return user.displayName || user.email?.split('@')[0] || 'User';
  }

  loadMoreReplies() {
    this.displayedRepliesCount += this.repliesPerPage;
  }

  get hasMoreReplies(): boolean {
    return (this.comment.replies?.length || 0) > this.displayedRepliesCount;
  }

  get remainingRepliesCount(): number {
    return Math.max(0, (this.comment.replies?.length || 0) - this.displayedRepliesCount);
  }

  get displayedReplies(): Comment[] {
    if (!this.comment.replies) return [];
    return this.comment.replies.slice(0, this.displayedRepliesCount);
  }

  onReplyAdded() {
    // Show the new reply by ensuring it's visible
    this.displayedRepliesCount = Math.max(this.displayedRepliesCount, (this.comment.replies?.length || 0));
    this.replyAdded.emit();
  }
} 