import fs from 'fs/promises';
import path from 'path';

export type WorkspaceStatus =
  | 'created'           // Workspace created, nothing done yet
  | 'analysis'          // Phase 1: Analysis in progress
  | 'analysis_done'     // Phase 1 complete, prompt generated
  | 'implementation'    // Phase 2: Implementation in progress
  | 'implementation_done' // Phase 2 complete, code written
  | 'review'            // Phase 3: Review in progress
  | 'review_failed'     // Review failed, needs retry
  | 'committed'         // Changes committed
  | 'pushed'            // Branch pushed to remote
  | 'mr_created'        // Merge request created
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
  createdAt: number;
  updatedAt: number;
}

export interface ProcessedData {
  processedMessageIds: string[];
  lastScanTimestamp: number;
  workspaces: Record<string, WorkspaceInfo>;  // messageId -> WorkspaceInfo
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
    extra?: Partial<Pick<WorkspaceInfo, 'developmentPrompt' | 'lastError' | 'mrUrl' | 'attempt'>>
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
      }
      await this.save();
      console.log(`[Storage] Updated workspace ${messageId} status: ${status}`);
    }
  }

  async deleteWorkspace(messageId: string): Promise<void> {
    if (this.data.workspaces[messageId]) {
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
}
