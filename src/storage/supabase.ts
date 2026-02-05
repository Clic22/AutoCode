import { createClient, SupabaseClient } from '@supabase/supabase-js';
import os from 'os';
import { WorkspaceStatus, WorkspaceInfo, ProcessedData } from './index';

interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  machineId?: string;
}

// Database row types
interface WorkspaceRow {
  message_id: string;
  branch_name: string;
  status: string;
  attempt: number;
  development_prompt: string | null;
  last_error: string | null;
  mr_url: string | null;
  last_feedback_at: number | null;
  feedback_count: number | null;
  thread_id: string | null;
  ideation_conversation: string[] | null;
  last_ideation_timestamp: number | null;
  source_message_id: string | null;
  source_channel_id: string | null;
  created_at: number;
  updated_at: number;
}

interface WorkspaceLocalPathRow {
  message_id: string;
  machine_id: string;
  workspace_path: string;
  repo_path: string;
}

export class SupabaseStorage {
  private client: SupabaseClient;
  private machineId: string;
  private cache: ProcessedData;
  private initialized = false;

  constructor(config: SupabaseConfig) {
    this.client = createClient(config.url, config.serviceRoleKey);
    this.machineId = config.machineId || this.generateMachineId();
    this.cache = {
      processedMessageIds: [],
      lastScanTimestamp: 0,
      workspaces: {},
      mrUrlIndex: {},
      branchIndex: {},
      processedCommentIds: [],
      sourceMessageIndex: {},
      threadIndex: {},
    };
  }

  private generateMachineId(): string {
    const hostname = os.hostname();
    const username = os.userInfo().username;
    return `${hostname}-${username}`;
  }

  async load(): Promise<void> {
    console.log(`[SupabaseStorage] Loading data for machine: ${this.machineId}`);

    try {
      // Load workspaces with local paths for this machine
      const { data: workspaces, error: workspacesError } = await this.client
        .from('workspaces')
        .select(`
          *,
          workspace_local_paths!inner(workspace_path, repo_path)
        `)
        .eq('workspace_local_paths.machine_id', this.machineId);

      if (workspacesError && workspacesError.code !== 'PGRST116') {
        // PGRST116 = no rows returned, which is fine
        console.error('[SupabaseStorage] Error loading workspaces:', workspacesError);
      }

      // Also load workspaces without local paths (they might exist on other machines)
      const { data: allWorkspaces, error: allWorkspacesError } = await this.client
        .from('workspaces')
        .select('*');

      if (allWorkspacesError) {
        console.error('[SupabaseStorage] Error loading all workspaces:', allWorkspacesError);
      }

      // Load local paths for this machine separately
      const { data: localPaths, error: localPathsError } = await this.client
        .from('workspace_local_paths')
        .select('*')
        .eq('machine_id', this.machineId);

      if (localPathsError) {
        console.error('[SupabaseStorage] Error loading local paths:', localPathsError);
      }

      // Build local paths map
      const localPathsMap = new Map<string, WorkspaceLocalPathRow>();
      if (localPaths) {
        for (const lp of localPaths) {
          localPathsMap.set(lp.message_id, lp);
        }
      }

      // Build workspaces cache
      if (allWorkspaces) {
        for (const ws of allWorkspaces) {
          const localPath = localPathsMap.get(ws.message_id);
          this.cache.workspaces[ws.message_id] = this.rowToWorkspaceInfo(ws, localPath);

          // Build indexes
          if (ws.mr_url) {
            this.cache.mrUrlIndex[ws.mr_url] = ws.message_id;
          }
          if (ws.branch_name) {
            this.cache.branchIndex[ws.branch_name] = ws.message_id;
          }
          if (ws.source_message_id) {
            this.cache.sourceMessageIndex[ws.source_message_id] = ws.message_id;
          }
          if (ws.thread_id) {
            this.cache.threadIndex[ws.thread_id] = ws.message_id;
          }
        }
      }

      // Load processed messages
      const { data: processedMessages, error: processedMessagesError } = await this.client
        .from('processed_messages')
        .select('message_id');

      if (processedMessagesError) {
        console.error('[SupabaseStorage] Error loading processed messages:', processedMessagesError);
      } else if (processedMessages) {
        this.cache.processedMessageIds = processedMessages.map((pm: { message_id: string }) => pm.message_id);
      }

      // Load processed comments
      const { data: processedComments, error: processedCommentsError } = await this.client
        .from('processed_comments')
        .select('comment_id');

      if (processedCommentsError) {
        console.error('[SupabaseStorage] Error loading processed comments:', processedCommentsError);
      } else if (processedComments) {
        this.cache.processedCommentIds = processedComments.map((pc: { comment_id: string }) => pc.comment_id);
      }

      // Load app state for this machine
      const { data: appState, error: appStateError } = await this.client
        .from('app_state')
        .select('*')
        .eq('machine_id', this.machineId)
        .single();

      if (appStateError && appStateError.code !== 'PGRST116') {
        console.error('[SupabaseStorage] Error loading app state:', appStateError);
      } else if (appState) {
        this.cache.lastScanTimestamp = appState.last_scan_timestamp;
      }

      this.initialized = true;
      console.log(`[SupabaseStorage] Loaded ${this.cache.processedMessageIds.length} processed message IDs`);
      console.log(`[SupabaseStorage] Loaded ${Object.keys(this.cache.workspaces).length} workspace records`);

    } catch (error) {
      console.error('[SupabaseStorage] Error during load:', error);
      throw error;
    }
  }

  private rowToWorkspaceInfo(row: WorkspaceRow, localPath?: WorkspaceLocalPathRow | null): WorkspaceInfo {
    return {
      messageId: row.message_id,
      workspacePath: localPath?.workspace_path || '',
      branchName: row.branch_name,
      repoPath: localPath?.repo_path || '',
      status: row.status as WorkspaceStatus,
      attempt: row.attempt,
      developmentPrompt: row.development_prompt || undefined,
      lastError: row.last_error || undefined,
      mrUrl: row.mr_url || undefined,
      lastFeedbackAt: row.last_feedback_at || undefined,
      feedbackCount: row.feedback_count || undefined,
      threadId: row.thread_id || undefined,
      ideationConversation: row.ideation_conversation || undefined,
      lastIdeationTimestamp: row.last_ideation_timestamp || undefined,
      sourceMessageId: row.source_message_id || undefined,
      sourceChannelId: row.source_channel_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async save(): Promise<void> {
    // No-op: Supabase storage saves on each operation
    // This method exists for API compatibility with file-based Storage
  }

  isProcessed(messageId: string): boolean {
    return this.cache.processedMessageIds.includes(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    if (!this.cache.processedMessageIds.includes(messageId)) {
      const { error } = await this.client
        .from('processed_messages')
        .upsert({ message_id: messageId, processed_at: Date.now() });

      if (error) {
        console.error('[SupabaseStorage] Error marking message as processed:', error);
        throw error;
      }

      this.cache.processedMessageIds.push(messageId);
    }
  }

  async updateLastScan(): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from('app_state')
      .upsert({
        machine_id: this.machineId,
        last_scan_timestamp: now,
        updated_at: now,
      });

    if (error) {
      console.error('[SupabaseStorage] Error updating last scan:', error);
      throw error;
    }

    this.cache.lastScanTimestamp = now;
  }

  getLastScanTimestamp(): number {
    return this.cache.lastScanTimestamp;
  }

  getProcessedIds(): string[] {
    return [...this.cache.processedMessageIds];
  }

  // Workspace management methods

  getWorkspace(messageId: string): WorkspaceInfo | undefined {
    return this.cache.workspaces[messageId];
  }

  hasWorkspace(messageId: string): boolean {
    return messageId in this.cache.workspaces;
  }

  async createWorkspace(info: Omit<WorkspaceInfo, 'createdAt' | 'updatedAt'>): Promise<WorkspaceInfo> {
    const now = Date.now();

    // Insert into workspaces table
    const { error: workspaceError } = await this.client
      .from('workspaces')
      .insert({
        message_id: info.messageId,
        branch_name: info.branchName,
        status: info.status,
        attempt: info.attempt,
        development_prompt: info.developmentPrompt || null,
        last_error: info.lastError || null,
        mr_url: info.mrUrl || null,
        last_feedback_at: info.lastFeedbackAt || null,
        feedback_count: info.feedbackCount || null,
        thread_id: info.threadId || null,
        ideation_conversation: info.ideationConversation || [],
        last_ideation_timestamp: info.lastIdeationTimestamp || null,
        source_message_id: info.sourceMessageId || null,
        source_channel_id: info.sourceChannelId || null,
        created_at: now,
        updated_at: now,
      });

    if (workspaceError) {
      console.error('[SupabaseStorage] Error creating workspace:', workspaceError);
      throw workspaceError;
    }

    // Insert local paths if provided
    if (info.workspacePath || info.repoPath) {
      const { error: localPathError } = await this.client
        .from('workspace_local_paths')
        .insert({
          message_id: info.messageId,
          machine_id: this.machineId,
          workspace_path: info.workspacePath,
          repo_path: info.repoPath,
          created_at: now,
          updated_at: now,
        });

      if (localPathError) {
        console.error('[SupabaseStorage] Error creating local path:', localPathError);
        // Don't throw - workspace was created successfully
      }
    }

    const workspace: WorkspaceInfo = {
      ...info,
      createdAt: now,
      updatedAt: now,
    };

    this.cache.workspaces[info.messageId] = workspace;
    console.log(`[SupabaseStorage] Created workspace record for ${info.messageId} (status: ${info.status})`);
    return workspace;
  }

  async updateWorkspaceStatus(
    messageId: string,
    status: WorkspaceStatus,
    extra?: Partial<Pick<WorkspaceInfo, 'developmentPrompt' | 'lastError' | 'mrUrl' | 'attempt' | 'lastFeedbackAt' | 'feedbackCount' | 'threadId' | 'ideationConversation' | 'lastIdeationTimestamp' | 'workspacePath' | 'repoPath'>>
  ): Promise<void> {
    const workspace = this.cache.workspaces[messageId];
    if (!workspace) {
      console.warn(`[SupabaseStorage] Workspace ${messageId} not found for update`);
      return;
    }

    const now = Date.now();

    // Build update object for workspaces table
    const workspaceUpdate: Record<string, any> = {
      status,
      updated_at: now,
    };

    if (extra) {
      if (extra.developmentPrompt !== undefined) workspaceUpdate.development_prompt = extra.developmentPrompt;
      if (extra.lastError !== undefined) workspaceUpdate.last_error = extra.lastError;
      if (extra.mrUrl !== undefined) workspaceUpdate.mr_url = extra.mrUrl;
      if (extra.attempt !== undefined) workspaceUpdate.attempt = extra.attempt;
      if (extra.lastFeedbackAt !== undefined) workspaceUpdate.last_feedback_at = extra.lastFeedbackAt;
      if (extra.feedbackCount !== undefined) workspaceUpdate.feedback_count = extra.feedbackCount;
      if (extra.threadId !== undefined) workspaceUpdate.thread_id = extra.threadId;
      if (extra.ideationConversation !== undefined) workspaceUpdate.ideation_conversation = extra.ideationConversation;
      if (extra.lastIdeationTimestamp !== undefined) workspaceUpdate.last_ideation_timestamp = extra.lastIdeationTimestamp;
    }

    const { error: workspaceError } = await this.client
      .from('workspaces')
      .update(workspaceUpdate)
      .eq('message_id', messageId);

    if (workspaceError) {
      console.error('[SupabaseStorage] Error updating workspace:', workspaceError);
      throw workspaceError;
    }

    // Update local paths if provided
    if (extra && (extra.workspacePath !== undefined || extra.repoPath !== undefined)) {
      const localPathUpdate: Record<string, any> = { updated_at: now };
      if (extra.workspacePath !== undefined) localPathUpdate.workspace_path = extra.workspacePath;
      if (extra.repoPath !== undefined) localPathUpdate.repo_path = extra.repoPath;

      const { error: localPathError } = await this.client
        .from('workspace_local_paths')
        .upsert({
          message_id: messageId,
          machine_id: this.machineId,
          workspace_path: extra.workspacePath || workspace.workspacePath,
          repo_path: extra.repoPath || workspace.repoPath,
          updated_at: now,
        });

      if (localPathError) {
        console.error('[SupabaseStorage] Error updating local path:', localPathError);
      }

      // Update cache
      if (extra.workspacePath !== undefined) workspace.workspacePath = extra.workspacePath;
      if (extra.repoPath !== undefined) workspace.repoPath = extra.repoPath;
    }

    // Update cache
    workspace.status = status;
    workspace.updatedAt = now;
    if (extra) {
      if (extra.developmentPrompt !== undefined) workspace.developmentPrompt = extra.developmentPrompt;
      if (extra.lastError !== undefined) workspace.lastError = extra.lastError;
      if (extra.mrUrl !== undefined) {
        // Update mrUrlIndex
        if (workspace.mrUrl && this.cache.mrUrlIndex[workspace.mrUrl] === messageId) {
          delete this.cache.mrUrlIndex[workspace.mrUrl];
        }
        workspace.mrUrl = extra.mrUrl;
        if (extra.mrUrl) {
          this.cache.mrUrlIndex[extra.mrUrl] = messageId;
        }
      }
      if (extra.attempt !== undefined) workspace.attempt = extra.attempt;
      if (extra.lastFeedbackAt !== undefined) workspace.lastFeedbackAt = extra.lastFeedbackAt;
      if (extra.feedbackCount !== undefined) workspace.feedbackCount = extra.feedbackCount;
      if (extra.threadId !== undefined) workspace.threadId = extra.threadId;
      if (extra.ideationConversation !== undefined) workspace.ideationConversation = extra.ideationConversation;
      if (extra.lastIdeationTimestamp !== undefined) workspace.lastIdeationTimestamp = extra.lastIdeationTimestamp;
    }

    console.log(`[SupabaseStorage] Updated workspace ${messageId} status: ${status}`);
  }

  async deleteWorkspace(messageId: string): Promise<void> {
    const workspace = this.cache.workspaces[messageId];
    if (!workspace) return;

    // Delete from database (cascade will delete local paths)
    const { error } = await this.client
      .from('workspaces')
      .delete()
      .eq('message_id', messageId);

    if (error) {
      console.error('[SupabaseStorage] Error deleting workspace:', error);
      throw error;
    }

    // Clean up cache
    if (workspace.mrUrl && this.cache.mrUrlIndex[workspace.mrUrl] === messageId) {
      delete this.cache.mrUrlIndex[workspace.mrUrl];
      console.log(`[SupabaseStorage] Removed MR URL index for ${workspace.mrUrl}`);
    }

    if (workspace.branchName && this.cache.branchIndex[workspace.branchName] === messageId) {
      delete this.cache.branchIndex[workspace.branchName];
      console.log(`[SupabaseStorage] Removed branch index for ${workspace.branchName}`);
    }

    if (workspace.sourceMessageId && this.cache.sourceMessageIndex[workspace.sourceMessageId] === messageId) {
      delete this.cache.sourceMessageIndex[workspace.sourceMessageId];
      console.log(`[SupabaseStorage] Removed source message index for ${workspace.sourceMessageId}`);
    }

    if (workspace.threadId && this.cache.threadIndex[workspace.threadId] === messageId) {
      delete this.cache.threadIndex[workspace.threadId];
      console.log(`[SupabaseStorage] Removed thread index for ${workspace.threadId}`);
    }

    delete this.cache.workspaces[messageId];
    console.log(`[SupabaseStorage] Deleted workspace record for ${messageId}`);
  }

  getIncompleteWorkspaces(): WorkspaceInfo[] {
    return Object.values(this.cache.workspaces).filter(
      w => w.status !== 'completed' && w.status !== 'failed'
    );
  }

  getAllWorkspaces(): WorkspaceInfo[] {
    return Object.values(this.cache.workspaces);
  }

  // MR feedback loop methods

  getWorkspaceByMrUrl(mrUrl: string): WorkspaceInfo | undefined {
    const messageId = this.cache.mrUrlIndex[mrUrl];
    return messageId ? this.cache.workspaces[messageId] : undefined;
  }

  getWorkspaceByBranch(branchName: string): WorkspaceInfo | undefined {
    const messageId = this.cache.branchIndex[branchName];
    return messageId ? this.cache.workspaces[messageId] : undefined;
  }

  async addMrUrlIndex(mrUrl: string, messageId: string): Promise<void> {
    // The index is maintained in memory and via the mr_url column in workspaces table
    this.cache.mrUrlIndex[mrUrl] = messageId;
    console.log(`[SupabaseStorage] Added MR URL index: ${mrUrl} -> ${messageId}`);
  }

  async addBranchIndex(branchName: string, messageId: string): Promise<void> {
    // The index is maintained in memory and via the branch_name column in workspaces table
    this.cache.branchIndex[branchName] = messageId;
    console.log(`[SupabaseStorage] Added branch index: ${branchName} -> ${messageId}`);
  }

  isCommentProcessed(commentId: string): boolean {
    return this.cache.processedCommentIds.includes(commentId);
  }

  async markCommentProcessed(commentId: string): Promise<void> {
    if (!this.cache.processedCommentIds.includes(commentId)) {
      const { error } = await this.client
        .from('processed_comments')
        .upsert({ comment_id: commentId, processed_at: Date.now() });

      if (error) {
        console.error('[SupabaseStorage] Error marking comment as processed:', error);
        throw error;
      }

      this.cache.processedCommentIds.push(commentId);
    }
  }

  getWorkspacesInStatus(...statuses: WorkspaceStatus[]): WorkspaceInfo[] {
    return Object.values(this.cache.workspaces).filter(
      w => statuses.includes(w.status)
    );
  }

  getMachineId(): string {
    return this.machineId;
  }

  async disconnect(): Promise<void> {
    // No-op: realtime subscription removed (not needed for single-instance usage)
  }

  // Cross-channel deduplication methods

  getWorkspaceBySourceMessage(sourceMessageId: string): WorkspaceInfo | undefined {
    const messageId = this.cache.sourceMessageIndex[sourceMessageId];
    if (!messageId) return undefined;
    return this.cache.workspaces[messageId];
  }

  async addSourceMessageIndex(sourceMessageId: string, messageId: string): Promise<void> {
    // The index is maintained in cache and via the source_message_id column in workspaces table
    this.cache.sourceMessageIndex[sourceMessageId] = messageId;
    console.log(`[SupabaseStorage] Added source message index: ${sourceMessageId} -> ${messageId}`);
  }

  // Thread lookup for Discord feedback

  getWorkspaceByThread(threadId: string): WorkspaceInfo | undefined {
    const messageId = this.cache.threadIndex[threadId];
    if (!messageId) return undefined;
    return this.cache.workspaces[messageId];
  }

  async addThreadIndex(threadId: string, messageId: string): Promise<void> {
    // The index is maintained in cache and via the thread_id column in workspaces table
    this.cache.threadIndex[threadId] = messageId;
    console.log(`[SupabaseStorage] Added thread index: ${threadId} -> ${messageId}`);
  }
}
