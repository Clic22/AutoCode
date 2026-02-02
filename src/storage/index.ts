import fs from 'fs/promises';
import path from 'path';

// Re-export SupabaseStorage
export { SupabaseStorage } from './supabase';

// Interface for storage implementations
export interface IStorage {
  load(): Promise<void>;
  save(): Promise<void>;
  isProcessed(messageId: string): boolean;
  markProcessed(messageId: string): Promise<void>;
  updateLastScan(): Promise<void>;
  getLastScanTimestamp(): number;
  getProcessedIds(): string[];
  getWorkspace(messageId: string): WorkspaceInfo | undefined;
  hasWorkspace(messageId: string): boolean;
  createWorkspace(info: Omit<WorkspaceInfo, 'createdAt' | 'updatedAt'>): Promise<WorkspaceInfo>;
  updateWorkspaceStatus(
    messageId: string,
    status: WorkspaceStatus,
    extra?: Partial<Pick<WorkspaceInfo, 'developmentPrompt' | 'lastError' | 'mrUrl' | 'attempt' | 'lastFeedbackAt' | 'feedbackCount' | 'threadId' | 'ideationConversation' | 'lastIdeationTimestamp' | 'workspacePath' | 'repoPath'>>
  ): Promise<void>;
  deleteWorkspace(messageId: string): Promise<void>;
  getIncompleteWorkspaces(): WorkspaceInfo[];
  getAllWorkspaces(): WorkspaceInfo[];
  getWorkspaceByMrUrl(mrUrl: string): WorkspaceInfo | undefined;
  getWorkspaceByBranch(branchName: string): WorkspaceInfo | undefined;
  addMrUrlIndex(mrUrl: string, messageId: string): Promise<void>;
  addBranchIndex(branchName: string, messageId: string): Promise<void>;
  isCommentProcessed(commentId: string): boolean;
  markCommentProcessed(commentId: string): Promise<void>;
  getWorkspacesInStatus(...statuses: WorkspaceStatus[]): WorkspaceInfo[];
}

export type WorkspaceStatus =
  | 'created'           // Workspace created, nothing done yet
  | 'ideation_pending'  // New message in private channel, ideation not started yet
  | 'ideation_in_progress' // Ideation phase active, asking questions
  | 'ideation_complete' // Ideation done, waiting for approval emoji
  | 'analysis'          // Phase 1: Analysis in progress
  | 'analysis_done'     // Phase 1 complete, prompt generated
  | 'implementation'    // Phase 2: Implementation in progress
  | 'implementation_done' // Phase 2 complete, code written
  | 'review'            // Phase 3: Review in progress
  | 'review_failed'     // Review failed, needs retry
  | 'committed'         // Changes committed
  | 'pushed'            // Branch pushed to remote
  | 'mr_created'        // Merge request created
  | 'mr_feedback_received' // Feedback command detected, queued for processing
  | 'awaiting_validation'  // Changes pushed after feedback, waiting for approval
  | 'completed'         // Fully completed
  | 'failed';           // Failed with error

export interface WorkspaceInfo {
  messageId: string;
  workspacePath: string;
  branchName: string;
  repoPath: string;
  status: WorkspaceStatus;
  attempt: number;              // Current attempt number (for retries)
  developmentPrompt?: string;   // Saved prompt for resuming
  lastError?: string;           // Last error message if failed
  mrUrl?: string;               // Merge request URL if created
  lastFeedbackAt?: number;      // Timestamp of last feedback received
  feedbackCount?: number;       // Number of feedback rounds processed
  // Ideation phase tracking
  threadId?: string;            // Discord thread ID for ideation conversation
  ideationConversation?: string[]; // Messages in ideation conversation
  lastIdeationTimestamp?: number; // Last ideation message timestamp
  createdAt: number;
  updatedAt: number;
}

export interface ProcessedData {
  processedMessageIds: string[];
  lastScanTimestamp: number;
  workspaces: Record<string, WorkspaceInfo>;  // messageId -> WorkspaceInfo
  mrUrlIndex: Record<string, string>;         // mrUrl -> messageId
  branchIndex: Record<string, string>;        // branchName -> messageId
  processedCommentIds: string[];              // GitLab comment IDs
}

export class Storage {
  private filePath: string;
  private data: ProcessedData;

  constructor(storagePath: string) {
    this.filePath = storagePath;
    this.data = {
      processedMessageIds: [],
      lastScanTimestamp: 0,
      workspaces: {},
      mrUrlIndex: {},
      branchIndex: {},
      processedCommentIds: [],
    };
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const loaded = JSON.parse(content);
      this.data = {
        processedMessageIds: loaded.processedMessageIds || [],
        lastScanTimestamp: loaded.lastScanTimestamp || 0,
        workspaces: loaded.workspaces || {},
        mrUrlIndex: loaded.mrUrlIndex || {},
        branchIndex: loaded.branchIndex || {},
        processedCommentIds: loaded.processedCommentIds || [],
      };
      console.log(`[Storage] Loaded ${this.data.processedMessageIds.length} processed message IDs`);
      console.log(`[Storage] Loaded ${Object.keys(this.data.workspaces).length} workspace records`);
    } catch (error) {
      // File doesn't exist yet, start fresh
      console.log('[Storage] No existing data found, starting fresh');
      this.data = {
        processedMessageIds: [],
        lastScanTimestamp: 0,
        workspaces: {},
        mrUrlIndex: {},
        branchIndex: {},
        processedCommentIds: [],
      };
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }

  isProcessed(messageId: string): boolean {
    return this.data.processedMessageIds.includes(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    if (!this.data.processedMessageIds.includes(messageId)) {
      this.data.processedMessageIds.push(messageId);
      await this.save();
    }
  }

  async updateLastScan(): Promise<void> {
    this.data.lastScanTimestamp = Date.now();
    await this.save();
  }

  getLastScanTimestamp(): number {
    return this.data.lastScanTimestamp;
  }

  getProcessedIds(): string[] {
    return [...this.data.processedMessageIds];
  }

  // Workspace management methods

  getWorkspace(messageId: string): WorkspaceInfo | undefined {
    return this.data.workspaces[messageId];
  }

  hasWorkspace(messageId: string): boolean {
    return messageId in this.data.workspaces;
  }

  async createWorkspace(info: Omit<WorkspaceInfo, 'createdAt' | 'updatedAt'>): Promise<WorkspaceInfo> {
    const now = Date.now();
    const workspace: WorkspaceInfo = {
      ...info,
      createdAt: now,
      updatedAt: now,
    };
    this.data.workspaces[info.messageId] = workspace;
    await this.save();
    console.log(`[Storage] Created workspace record for ${info.messageId} (status: ${info.status})`);
    return workspace;
  }

  async updateWorkspaceStatus(
    messageId: string,
    status: WorkspaceStatus,
    extra?: Partial<Pick<WorkspaceInfo, 'developmentPrompt' | 'lastError' | 'mrUrl' | 'attempt' | 'lastFeedbackAt' | 'feedbackCount' | 'threadId' | 'ideationConversation' | 'lastIdeationTimestamp' | 'workspacePath' | 'repoPath'>>
  ): Promise<void> {
    const workspace = this.data.workspaces[messageId];
    if (workspace) {
      workspace.status = status;
      workspace.updatedAt = Date.now();
      if (extra) {
        if (extra.developmentPrompt !== undefined) workspace.developmentPrompt = extra.developmentPrompt;
        if (extra.lastError !== undefined) workspace.lastError = extra.lastError;
        if (extra.mrUrl !== undefined) workspace.mrUrl = extra.mrUrl;
        if (extra.attempt !== undefined) workspace.attempt = extra.attempt;
        if (extra.lastFeedbackAt !== undefined) workspace.lastFeedbackAt = extra.lastFeedbackAt;
        if (extra.feedbackCount !== undefined) workspace.feedbackCount = extra.feedbackCount;
        if (extra.threadId !== undefined) workspace.threadId = extra.threadId;
        if (extra.ideationConversation !== undefined) workspace.ideationConversation = extra.ideationConversation;
        if (extra.lastIdeationTimestamp !== undefined) workspace.lastIdeationTimestamp = extra.lastIdeationTimestamp;
        if (extra.workspacePath !== undefined) workspace.workspacePath = extra.workspacePath;
        if (extra.repoPath !== undefined) workspace.repoPath = extra.repoPath;
      }
      await this.save();
      console.log(`[Storage] Updated workspace ${messageId} status: ${status}`);
    }
  }

  async deleteWorkspace(messageId: string): Promise<void> {
    const workspace = this.data.workspaces[messageId];
    if (workspace) {
      // Clean up mrUrlIndex
      if (workspace.mrUrl && this.data.mrUrlIndex[workspace.mrUrl] === messageId) {
        delete this.data.mrUrlIndex[workspace.mrUrl];
        console.log(`[Storage] Removed MR URL index for ${workspace.mrUrl}`);
      }

      // Clean up branchIndex
      if (workspace.branchName && this.data.branchIndex[workspace.branchName] === messageId) {
        delete this.data.branchIndex[workspace.branchName];
        console.log(`[Storage] Removed branch index for ${workspace.branchName}`);
      }

      delete this.data.workspaces[messageId];
      await this.save();
      console.log(`[Storage] Deleted workspace record for ${messageId}`);
    }
  }

  getIncompleteWorkspaces(): WorkspaceInfo[] {
    return Object.values(this.data.workspaces).filter(
      w => w.status !== 'completed' && w.status !== 'failed'
    );
  }

  getAllWorkspaces(): WorkspaceInfo[] {
    return Object.values(this.data.workspaces);
  }

  // MR feedback loop methods

  getWorkspaceByMrUrl(mrUrl: string): WorkspaceInfo | undefined {
    const messageId = this.data.mrUrlIndex[mrUrl];
    return messageId ? this.data.workspaces[messageId] : undefined;
  }

  getWorkspaceByBranch(branchName: string): WorkspaceInfo | undefined {
    const messageId = this.data.branchIndex[branchName];
    return messageId ? this.data.workspaces[messageId] : undefined;
  }

  async addMrUrlIndex(mrUrl: string, messageId: string): Promise<void> {
    this.data.mrUrlIndex[mrUrl] = messageId;
    await this.save();
    console.log(`[Storage] Added MR URL index: ${mrUrl} -> ${messageId}`);
  }

  async addBranchIndex(branchName: string, messageId: string): Promise<void> {
    this.data.branchIndex[branchName] = messageId;
    await this.save();
    console.log(`[Storage] Added branch index: ${branchName} -> ${messageId}`);
  }

  isCommentProcessed(commentId: string): boolean {
    return this.data.processedCommentIds.includes(commentId);
  }

  async markCommentProcessed(commentId: string): Promise<void> {
    if (!this.data.processedCommentIds.includes(commentId)) {
      this.data.processedCommentIds.push(commentId);
      await this.save();
    }
  }

  getWorkspacesInStatus(...statuses: WorkspaceStatus[]): WorkspaceInfo[] {
    return Object.values(this.data.workspaces).filter(
      w => statuses.includes(w.status)
    );
  }
}
