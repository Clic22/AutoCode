import { GitLabClient, MRComment } from './index';
import { Storage, WorkspaceInfo } from '../storage';

export interface GitLabMonitorEvents {
  onFeedbackReceived: (feedback: FeedbackRequest) => Promise<void>;
  onValidationApproved: (messageId: string) => Promise<void>;
}

export interface FeedbackRequest {
  messageId: string;
  mrUrl: string;
  mrIid: number;
  feedback: string;
  author: string;
  timestamp: Date;
}

export class GitLabMonitor {
  private gitlabClient: GitLabClient;
  private storage: Storage;
  private events: GitLabMonitorEvents;
  private pollingInterval: number;
  private approvedUsers: string[];
  private sessionProcessed: Set<string> = new Set();
  private isMonitoring: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    gitlabClient: GitLabClient,
    storage: Storage,
    events: GitLabMonitorEvents,
    pollingInterval: number = 60000,
    approvedUsers: string[] = []
  ) {
    this.gitlabClient = gitlabClient;
    this.storage = storage;
    this.events = events;
    this.pollingInterval = pollingInterval;
    this.approvedUsers = approvedUsers;
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      console.log('[GitLabMonitor] Already monitoring');
      return;
    }

    this.isMonitoring = true;
    console.log(`[GitLabMonitor] Starting MR comment monitoring (interval: ${this.pollingInterval}ms)`);

    // Initial scan
    await this.scanMRsForComments();

    // Schedule periodic scans
    this.pollTimer = setInterval(async () => {
      try {
        await this.scanMRsForComments();
      } catch (error: any) {
        console.error(`[GitLabMonitor] Error during scan: ${error.message}`);
      }
    }, this.pollingInterval);
  }

  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[GitLabMonitor] Stopped monitoring');
  }

  /**
   * Scan all MRs in mr_created or awaiting_validation status for new comments
   */
  private async scanMRsForComments(): Promise<void> {
    // Get all workspaces that are in mr_created or awaiting_validation status
    const workspaces = this.storage.getWorkspacesInStatus('mr_created', 'awaiting_validation');

    if (workspaces.length === 0) {
      return;
    }

    console.log(`[GitLabMonitor] Scanning ${workspaces.length} MRs for comments...`);

    for (const workspace of workspaces) {
      if (!workspace.mrUrl) {
        console.log(`[GitLabMonitor] Workspace ${workspace.messageId} has no MR URL, skipping`);
        continue;
      }

      try {
        await this.scanMRComments(workspace.mrUrl, workspace.messageId);
      } catch (error: any) {
        console.error(`[GitLabMonitor] Error scanning MR ${workspace.mrUrl}: ${error.message}`);
      }
    }
  }

  /**
   * Scan a specific MR for new comments
   */
  private async scanMRComments(mrUrl: string, messageId: string): Promise<void> {
    try {
      // Extract MR IID from URL
      const mrIid = this.gitlabClient.getMRIidFromUrl(mrUrl);

      // Check if MR is still open
      const mrInfo = await this.gitlabClient.getMRInfo(mrIid);
      if (mrInfo.state !== 'opened') {
        console.log(`[GitLabMonitor] MR !${mrIid} is ${mrInfo.state}, marking workspace as completed`);
        await this.storage.updateWorkspaceStatus(messageId, 'completed');
        return;
      }

      // Get all comments
      const comments = await this.gitlabClient.getMRComments(mrIid);

      // Process each comment
      for (const comment of comments) {
        const commentId = `${mrIid}-${comment.id}`;

        // Skip if already processed
        if (this.storage.isCommentProcessed(commentId) || this.sessionProcessed.has(commentId)) {
          continue;
        }

        // Check for feedback command
        const feedback = this.extractFeedbackFromComment(comment.body);
        if (feedback) {
          console.log(`[GitLabMonitor] Found feedback command in MR !${mrIid} from ${comment.author.username}`);

          // Mark comment as processed
          await this.storage.markCommentProcessed(commentId);
          this.sessionProcessed.add(commentId);

          // Emit feedback received event
          await this.events.onFeedbackReceived({
            messageId,
            mrUrl,
            mrIid,
            feedback,
            author: comment.author.username,
            timestamp: new Date(comment.created_at),
          });
          continue;
        }

        // Check for approval comment
        if (this.isApprovalComment(comment.body, comment.author.username)) {
          console.log(`[GitLabMonitor] Found approval comment in MR !${mrIid} from ${comment.author.username}`);

          // Mark comment as processed
          await this.storage.markCommentProcessed(commentId);
          this.sessionProcessed.add(commentId);

          // Emit validation approved event
          await this.events.onValidationApproved(messageId);
          continue;
        }
      }
    } catch (error: any) {
      console.error(`[GitLabMonitor] Error processing MR comments: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract feedback text from comment body
   * Returns null if not a feedback command
   */
  private extractFeedbackFromComment(commentBody: string): string | null {
    const regex = /^\/autocode\s+(.+)$/im;
    const match = commentBody.match(regex);

    if (match && match[1]) {
      const feedback = match[1].trim();

      // Validate feedback length
      if (feedback.length > 5000) {
        console.warn(`[GitLabMonitor] Feedback too long (${feedback.length} chars), truncating to 5000`);
        return feedback.substring(0, 5000);
      }

      return feedback;
    }

    return null;
  }

  /**
   * Check if comment is an approval comment
   */
  private isApprovalComment(commentBody: string, author: string): boolean {
    // Check if author is approved
    if (!this.isApprovedUser(author)) {
      return false;
    }

    const commentLower = commentBody.toLowerCase().trim();
    const keywords = [
      'autocode validate',
      'autocode approved',
      'autocode done',
      '/approve',
    ];

    return keywords.some(kw => commentLower.includes(kw));
  }

  /**
   * Check if user is in approved users list
   */
  private isApprovedUser(username: string): boolean {
    // If no approved users configured, allow all
    if (this.approvedUsers.length === 0) {
      return true;
    }

    return this.approvedUsers.includes(username);
  }
}
