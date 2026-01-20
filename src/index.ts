import { loadConfig, Config } from './config';
import { DiscordBot, CodeRequest } from './discord';
import { WorkspaceManager, Workspace } from './workspace';
import { GitManager } from './git';
import { GitLabClient } from './gitlab';
import { ClaudeOrchestrator } from './claude';
import { Storage } from './storage';
import path from 'path';

const MAX_CONCURRENT_REQUESTS = 3;

class AutoCode {
  private config: Config;
  private discord: DiscordBot;
  private workspaceManager: WorkspaceManager;
  private gitManager: GitManager;
  private gitlabClient: GitLabClient;
  private claudeOrchestrator: ClaudeOrchestrator;
  private storage: Storage;
  private activeRequests: number = 0;
  private requestQueue: CodeRequest[] = [];

  constructor(config: Config, storage: Storage) {
    this.config = config;
    this.storage = storage;

    // Initialize components
    this.workspaceManager = new WorkspaceManager(config.workspacesDir);
    this.gitManager = new GitManager(
      config.gitlab.token,
      config.gitlab.repoUrl,
      config.workspacesDir,
      'release/preview'  // Base branch
    );
    this.gitlabClient = new GitLabClient(
      config.gitlab.url,
      config.gitlab.token,
      config.gitlab.projectId
    );
    this.claudeOrchestrator = new ClaudeOrchestrator(config.claudeCliPath);

    // Initialize Discord bot with event handlers and storage
    this.discord = new DiscordBot(
      config.discord.channelId,
      config.discord.approvalEmoji,
      {
        onRequestApproved: this.handleApprovedRequest.bind(this),
      },
      storage
    );
  }

  async start(): Promise<void> {
    console.log('='.repeat(50));
    console.log('AutoCode - Discord-driven Code Generation');
    console.log('='.repeat(50));

    // Initialize workspace directory
    await this.workspaceManager.initialize();

    // Initialize base repository (clone once, then just fetch)
    console.log('\n[AutoCode] Initializing base repository...');
    await this.gitManager.pruneWorktrees();
    await this.gitManager.ensureBaseRepo();

    // Connect to Discord
    await this.discord.connect(this.config.discord.botToken);

    // Scan channel for existing approved messages
    console.log('\n[AutoCode] Scanning for pending approved requests...');
    const pendingRequests = await this.discord.scanChannelForApprovedMessages();

    if (pendingRequests.length > 0) {
      console.log(`[AutoCode] Found ${pendingRequests.length} pending requests, processing in parallel (max ${MAX_CONCURRENT_REQUESTS})...`);
      for (const request of pendingRequests) {
        this.requestQueue.push(request);
      }
      // Start processing queue (up to MAX_CONCURRENT_REQUESTS in parallel)
      this.processNextRequests();
    } else {
      console.log('[AutoCode] No pending requests found.');
    }

    // Update last scan timestamp
    await this.storage.updateLastScan();

    console.log('\n[AutoCode] Ready and waiting for new approved requests...');
  }

  private async handleApprovedRequest(request: CodeRequest): Promise<void> {
    // Add to queue
    this.requestQueue.push(request);
    console.log(`[AutoCode] Request ${request.id} added to queue (${this.requestQueue.length} pending, ${this.activeRequests} active)`);

    // Try to process more requests
    this.processNextRequests();
  }

  private processNextRequests(): void {
    // Start new requests up to the max concurrent limit
    while (this.requestQueue.length > 0 && this.activeRequests < MAX_CONCURRENT_REQUESTS) {
      const request = this.requestQueue.shift()!;
      this.activeRequests++;

      console.log(`[AutoCode] Starting request ${request.id} (${this.activeRequests}/${MAX_CONCURRENT_REQUESTS} active, ${this.requestQueue.length} queued)`);

      // Process request without awaiting - runs in parallel
      this.processRequest(request)
        .finally(() => {
          this.activeRequests--;
          console.log(`[AutoCode] Request ${request.id} finished (${this.activeRequests}/${MAX_CONCURRENT_REQUESTS} active, ${this.requestQueue.length} queued)`);
          // Try to start more requests when one finishes
          this.processNextRequests();
        });
    }
  }

  private async processRequest(request: CodeRequest): Promise<void> {
    console.log('\n' + '='.repeat(50));
    console.log(`[AutoCode] Processing request: ${request.id}`);
    console.log(`[AutoCode] Content: ${request.content.substring(0, 200)}...`);
    console.log('='.repeat(50));

    let workspace: Workspace | null = null;

    try {
      // Step 1: Create workspace
      console.log('\n[Step 1] Creating workspace...');
      workspace = await this.workspaceManager.create(request.id);

      // Step 2: Create worktree with feature branch (fast - uses base repo)
      console.log('\n[Step 2] Creating worktree from base repository...');
      const branchName = this.generateBranchName(request.content);
      const repoPath = await this.gitManager.createWorktree(workspace, branchName);

      // Step 3: Execute Claude CLI (three-phase: analysis + implementation + review)
      console.log('\n[Step 3] Executing Claude CLI (three-phase process)...');
      const claudeResult = await this.claudeOrchestrator.executeTask(
        repoPath,
        request.content,
        request.threadMessages,
        workspace.path  // Save development prompt in workspace
      );

      if (!claudeResult.success) {
        throw new Error(`Claude execution failed: ${claudeResult.error}`);
      }

      // Step 4: Check for changes and commit
      console.log('\n[Step 4] Committing changes...');
      const hasChanges = await this.gitManager.hasChanges(repoPath);

      if (!hasChanges) {
        console.log('[AutoCode] No changes were made by Claude');
        await this.discord.replyToMessage(
          request.channelId,
          request.messageId,
          `⚠️ AutoCode processed the request but no code changes were made.`
        );
        // Mark as processed even if no changes
        await this.storage.markProcessed(request.id);
        return;
      }

      const commitMessage = `AutoCode: Implement feature from Discord request

Request: ${request.content.substring(0, 100)}...
Requested by: ${request.author}
Approved by: ${request.approvedBy}
Request ID: ${request.id}`;

      await this.gitManager.commitAll(repoPath, commitMessage);

      // Step 5: Push to remote
      console.log('\n[Step 5] Pushing to remote...');
      await this.gitManager.push(repoPath, branchName);

      // Step 6: Create Merge Request
      console.log('\n[Step 6] Creating Merge Request...');
      const targetBranch = 'release/preview';
      const mrResult = await this.gitlabClient.createMergeRequest({
        sourceBranch: branchName,
        targetBranch: targetBranch,
        title: `AutoCode: ${request.content.substring(0, 80)}`,
        description: `## Feature Request from Discord

**Original Request:**
${request.content}

**Requested by:** ${request.author}
**Approved by:** ${request.approvedBy}
**Request ID:** ${request.id}

---
*This merge request was automatically generated by AutoCode.*`,
      });

      // Step 7: Mark as processed in persistent storage
      await this.storage.markProcessed(request.id);

      // Step 8: Notify Discord
      console.log('\n[Step 8] Notifying Discord...');
      await this.discord.replyToMessage(
        request.channelId,
        request.messageId,
        `✅ AutoCode has completed the implementation!

🔗 **Merge Request:** ${mrResult.webUrl}

Please review the changes and merge when ready.`
      );

      console.log('\n' + '='.repeat(50));
      console.log(`[AutoCode] Request ${request.id} completed successfully!`);
      console.log(`[AutoCode] MR: ${mrResult.webUrl}`);
      console.log('='.repeat(50));

    } catch (error) {
      console.error(`[AutoCode] Error processing request ${request.id}:`, error);

      // Notify Discord of failure
      try {
        await this.discord.replyToMessage(
          request.channelId,
          request.messageId,
          `❌ AutoCode encountered an error while processing this request:\n\`\`\`\n${error instanceof Error ? error.message : 'Unknown error'}\n\`\`\``
        );
      } catch (discordError) {
        console.error('[AutoCode] Failed to notify Discord of error:', discordError);
      }

      // Don't mark as processed on error, so it can be retried
    } finally {
      // Cleanup workspace (optional - uncomment to auto-cleanup)
      // if (workspace) {
      //   await this.workspaceManager.cleanup(workspace);
      // }
    }
  }

  private generateBranchName(content: string): string {
    // Determine if it's a fix or feature based on keywords
    const contentLower = content.toLowerCase();
    const isFix = contentLower.includes('bug') ||
                  contentLower.includes('fix') ||
                  contentLower.includes('crash') ||
                  contentLower.includes('error') ||
                  contentLower.includes('issue') ||
                  contentLower.includes('problem') ||
                  contentLower.includes('broken');

    const prefix = isFix ? 'fix' : 'feature';

    // Extract title - first line or text before newline, remove markdown formatting
    let title = content
      .split('\n')[0]                          // First line
      .replace(/^\*\*(.+)\*\*$/, '$1')         // Remove **bold**
      .replace(/^#+\s*/, '')                   // Remove # headers
      .trim();

    // If title is too long, truncate to first meaningful part
    if (title.length > 50) {
      title = title.substring(0, 50);
    }

    // Sanitize for git branch name
    const sanitized = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')           // Remove special chars
      .replace(/\s+/g, '-')                    // Spaces to dashes
      .replace(/-+/g, '-')                     // Multiple dashes to single
      .replace(/^-|-$/g, '')                   // Remove leading/trailing dashes
      .substring(0, 40);                       // Limit length

    // Add timestamp to ensure uniqueness
    const timestamp = Date.now().toString(36); // Short base36 timestamp

    return `${prefix}/${sanitized}-${timestamp}`;
  }

  async stop(): Promise<void> {
    console.log('[AutoCode] Shutting down...');
    await this.discord.disconnect();
    console.log('[AutoCode] Shutdown complete');
  }
}

// Main entry point
async function main(): Promise<void> {
  console.log('[AutoCode] Starting...');

  const config = loadConfig();

  // Initialize storage
  const storagePath = path.join(config.workspacesDir, '..', 'autocode-data.json');
  const storage = new Storage(storagePath);
  await storage.load();

  const autocode = new AutoCode(config, storage);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[AutoCode] Received SIGINT, shutting down gracefully...');
    await autocode.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[AutoCode] Received SIGTERM, shutting down gracefully...');
    await autocode.stop();
    process.exit(0);
  });

  await autocode.start();
}

main().catch((error) => {
  console.error('[AutoCode] Fatal error:', error);
  process.exit(1);
});
