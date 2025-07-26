import { Injectable } from '@angular/core';
import { 
  Firestore, 
  collection, 
  doc, 
  addDoc, 
  getDocs, 
  deleteDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  increment,
  query, 
  orderBy, 
  where, 
  Timestamp,
  DocumentReference
} from '@angular/fire/firestore';
import { Observable, from, map } from 'rxjs';

export interface Comment {
  id?: string;
  articleId: string;
  parentCommentId?: string; // For nested replies
  author: string;
  email?: string; // Optional email
  content: string;
  createdAt: Timestamp;
  likes?: number; // Number of likes
  likedBy?: string[]; // Array of user emails who liked this comment
  replies?: Comment[];
}

@Injectable({
  providedIn: 'root'
})
export class CommentService {
  constructor(private firestore: Firestore) {}

  // Add a new comment
  async addComment(comment: Omit<Comment, 'id' | 'createdAt'>): Promise<string> {
    const commentsCollection = collection(this.firestore, 'comments');
    
    // Only include email if it's provided and not empty
    const newComment: any = {
      articleId: comment.articleId,
      author: comment.author,
      content: comment.content,
      createdAt: Timestamp.now(),
      likes: 0,
      likedBy: []
    };

    // Add optional fields if they exist
    if (comment.email && comment.email.trim() !== '') {
      newComment.email = comment.email;
    }
    
    if (comment.parentCommentId) {
      newComment.parentCommentId = comment.parentCommentId;
    }
    
    const docRef = await addDoc(commentsCollection, newComment);
    return docRef.id;
  }

  // Get all comments for a specific article with nested replies
  getCommentsForArticle(articleId: string): Observable<Comment[]> {
    const commentsCollection = collection(this.firestore, 'comments');
    const q = query(
      commentsCollection,
      where('articleId', '==', articleId),
      orderBy('createdAt', 'asc')
    );

    return from(getDocs(q)).pipe(
      map(snapshot => {
        const allComments = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Comment[];

        // Organize comments into a hierarchy
        return this.organizeCommentsHierarchy(allComments);
      })
    );
  }

  // Organize flat list of comments into hierarchical structure
  private organizeCommentsHierarchy(comments: Comment[]): Comment[] {
    const commentMap = new Map<string, Comment>();
    const rootComments: Comment[] = [];

    // First pass: create a map of all comments
    comments.forEach(comment => {
      comment.replies = [];
      commentMap.set(comment.id!, comment);
    });

    // Second pass: organize into hierarchy
    comments.forEach(comment => {
      if (comment.parentCommentId) {
        // This is a reply
        const parentComment = commentMap.get(comment.parentCommentId);
        if (parentComment) {
          parentComment.replies!.push(comment);
        }
      } else {
        // This is a root comment
        rootComments.push(comment);
      }
    });

    return rootComments;
  }

  // Get comments count for an article
  async getCommentsCount(articleId: string): Promise<number> {
    const commentsCollection = collection(this.firestore, 'comments');
    const q = query(commentsCollection, where('articleId', '==', articleId));
    const snapshot = await getDocs(q);
    return snapshot.size;
  }

  // Delete a comment (admin only)
  async deleteComment(commentId: string): Promise<void> {
    const commentDoc = doc(this.firestore, 'comments', commentId);
    await deleteDoc(commentDoc);
  }

  // Delete all replies to a comment (admin only)
  async deleteCommentAndReplies(commentId: string): Promise<void> {
    const commentsCollection = collection(this.firestore, 'comments');
    
    // First, delete all replies to this comment
    const repliesQuery = query(
      commentsCollection,
      where('parentCommentId', '==', commentId)
    );
    const repliesSnapshot = await getDocs(repliesQuery);
    
    // Delete all replies
    const deletePromises = repliesSnapshot.docs.map(doc => deleteDoc(doc.ref));
    await Promise.all(deletePromises);
    
    // Then delete the main comment
    await this.deleteComment(commentId);
  }

  // Like a comment
  async likeComment(commentId: string, userEmail: string): Promise<void> {
    const commentDoc = doc(this.firestore, 'comments', commentId);
    await updateDoc(commentDoc, {
      likes: increment(1),
      likedBy: arrayUnion(userEmail)
    });
  }

  // Unlike a comment
  async unlikeComment(commentId: string, userEmail: string): Promise<void> {
    const commentDoc = doc(this.firestore, 'comments', commentId);
    await updateDoc(commentDoc, {
      likes: increment(-1),
      likedBy: arrayRemove(userEmail)
    });
  }

  // Check if user has liked a comment
  hasUserLiked(comment: Comment, userEmail: string | null): boolean {
    if (!userEmail || !comment.likedBy) return false;
    return comment.likedBy.includes(userEmail);
  }
} 