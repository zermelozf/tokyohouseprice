import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CommentService, Comment, CommentSubmission, CommentsData } from '../../services/comment.service';
import { CommentItemComponent } from '../comment-item/comment-item.component';
import { AdminLoginComponent } from '../admin-login/admin-login.component';
import { AuthService } from '../../services/auth.service';
import { RecaptchaService } from '../../services/recaptcha.service';
import { Observable, map, Subscription, combineLatest } from 'rxjs';

@Component({
  selector: 'app-comments',
  standalone: true,
  imports: [CommonModule, FormsModule, CommentItemComponent, AdminLoginComponent],
  templateUrl: './comments.component.html',
  styleUrls: ['./comments.component.scss']
})
export class CommentsComponent implements OnInit, OnDestroy {
  @Input() articleId!: string;

  commentsData$!: Observable<CommentsData>;
  comments$!: Observable<Comment[]>;
  sortedComments$!: Observable<Comment[]>;
  displayedComments$!: Observable<Comment[]>;
  commentsCount$!: Observable<number>;
  commentsCount = 0;
  isLoading = true;
  isSubmitting = false;
  showAdminLogin = false;
  sortBy: 'date' | 'dateOld' | 'likes' = 'date';

  customDisplayName = '';
  private userSubscription?: Subscription;
  private commentsSubscription?: Subscription;

  // Pagination properties
  displayedCommentsCount = 3;
  commentsPerPage = 5;
  allComments: Comment[] = [];

  newComment = {
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
    this.initializeComments();
    
    // Subscribe to user changes to load custom display name
    this.userSubscription = this.authService.user$.subscribe(user => {
      if (user) {
        this.loadCustomDisplayName(user);
      } else {
        this.customDisplayName = '';
      }
    });
    
    // Pre-load reCAPTCHA
    this.recaptchaService.loadRecaptcha().catch(error => {
      console.error('Failed to load reCAPTCHA:', error);
    });
  }

  initializeComments() {
    this.isLoading = true;
    
    // Get real-time comments data (comments + count combined)
    this.commentsData$ = this.commentService.getCommentsData(this.articleId);
    this.comments$ = this.commentsData$.pipe(map(data => data.comments));
    this.commentsCount$ = this.commentsData$.pipe(map(data => data.count));
    
    // Subscribe to comments data for component state updates
    this.commentsSubscription = this.commentsData$.subscribe(data => {
      this.allComments = data.comments;
      this.commentsCount = data.count;
      this.isLoading = false;
    });
    
    this.updateSortedComments();
  }

  updateSortedComments() {
    this.sortedComments$ = this.comments$.pipe(
      map(comments => this.sortComments(comments))
    );
    this.updateDisplayedComments();
  }

  updateDisplayedComments() {
    this.displayedComments$ = this.sortedComments$.pipe(
      map(comments => {
        this.allComments = comments;
        return comments.slice(0, this.displayedCommentsCount);
      })
    );
  }

  onSortChange() {
    this.updateSortedComments();
  }

  loadMoreComments() {
    this.displayedCommentsCount += this.commentsPerPage;
    this.updateDisplayedComments();
  }

  get hasMoreComments(): boolean {
    return this.allComments.length > this.displayedCommentsCount;
  }

  get remainingCommentsCount(): number {
    return Math.max(0, this.allComments.length - this.displayedCommentsCount);
  }

  private sortComments(comments: Comment[]): Comment[] {
    return [...comments].sort((a, b) => {
      switch (this.sortBy) {
        case 'date':
          return b.createdAt.toMillis() - a.createdAt.toMillis(); // Newest first
        case 'dateOld':
          return a.createdAt.toMillis() - b.createdAt.toMillis(); // Oldest first
        case 'likes':
          return (b.likes || 0) - (a.likes || 0); // Most liked first
        default:
          return 0;
      }
    });
  }

  // Note: loadCommentsCount is no longer needed as count is provided via real-time commentsData$

  async onSubmitComment() {
    if (this.isSubmitting) return;

    this.isSubmitting = true;
    try {
      const currentUser = this.authService.getCurrentUser();
      const emailToUse = currentUser?.email || this.newComment.email;
      const authorToUse = currentUser ? this.getUserDisplayName(currentUser) : this.newComment.author;

      // Save custom display name if user is logged in
      if (currentUser) {
        this.saveCustomDisplayName();
      }

      // Get reCAPTCHA token
      let recaptchaToken: string;
      try {
        recaptchaToken = await this.recaptchaService.getToken('comment');
      } catch (error) {
        console.error('reCAPTCHA failed:', error);
        alert('reCAPTCHA verification failed. Please try again.');
        return;
      }

      // Prepare comment submission with reCAPTCHA token
      const submission: CommentSubmission = {
        articleId: this.articleId,
        author: authorToUse,
        email: emailToUse,
        content: this.newComment.content,
        recaptchaToken: recaptchaToken
      };

      await this.commentService.addComment(submission);

      // Reset form (but keep custom display name for logged in users)
      this.newComment = {
        author: '',
        email: '',
        content: ''
      };

      // Reset pagination to show new comment (real-time updates will handle the rest)
      this.displayedCommentsCount = Math.max(3, this.displayedCommentsCount);
    } catch (error) {
      console.error('Error adding comment:', error);
      if (error instanceof Error) {
        alert(error.message);
      } else {
        alert('Failed to add comment. Please try again.');
      }
    } finally {
      this.isSubmitting = false;
    }
  }

  getUserDisplayName(user: any): string {
    return this.customDisplayName?.trim() || this.getDefaultDisplayName(user);
  }

  getDefaultDisplayName(user: any): string {
    return user.displayName || user.email?.split('@')[0] || 'User';
  }

  loadCustomDisplayName(user?: any) {
    const currentUser = user || this.authService.getCurrentUser();
    if (currentUser?.email) {
      const saved = localStorage.getItem(`customDisplayName_${currentUser.email}`);
      this.customDisplayName = saved || this.getDefaultDisplayName(currentUser);
    }
  }

  saveCustomDisplayName() {
    const currentUser = this.authService.getCurrentUser();
    if (currentUser?.email) {
      const trimmedName = this.customDisplayName?.trim() || '';
      const defaultName = this.getDefaultDisplayName(currentUser);
      
      // Only save if the name is different from the default
      if (trimmedName && trimmedName !== defaultName) {
        localStorage.setItem(`customDisplayName_${currentUser.email}`, trimmedName);
      } else {
        localStorage.removeItem(`customDisplayName_${currentUser.email}`);
      }
    }
  }

  onReplyAdded() {
    // BehaviorSubject automatically updates all subscribers when data changes
    // No need to manually refresh - the service handles this automatically
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
    // Admin controls will be visible automatically due to auth state changes and real-time updates
  }

  ngOnDestroy() {
    if (this.userSubscription) {
      this.userSubscription.unsubscribe();
    }
    if (this.commentsSubscription) {
      this.commentsSubscription.unsubscribe();
    }
  }
} 