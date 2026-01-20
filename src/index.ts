import { loadConfig, Config } from './config';
import { DiscordBot, CodeRequest } from './discord';
import { WorkspaceManager, Workspace } from './workspace';
import { GitManager } from './git';
import { GitLabClient } from './gitlab';
import { ClaudeOrchestrator } from './claude';
import { Storage } from './storage';
import path from 'path';

class AutoCode {
  private config: Config;
  private discord: DiscordBot;
  private workspaceManager: WorkspaceManager;
  private gitManager: GitManager;
  private gitlabClient: GitLabClient;
  private claudeOrchestrator: ClaudeOrchestrator;
  private storage: Storage;
  private isProcessing: boolean = false;
  private requestQueue: CodeRequest[] = [];

  constructor(config: Config, storage: Storage) {
    this.config = config;
    this.storage = storage;

    // Initialize components
    this.workspaceManager = new WorkspaceManager(config.workspacesDir);
    this.gitManager = new GitManager(config.gitlab.token);
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

    // Connect to Discord
    await this.discord.connect(this.config.discord.botToken);

    // Scan channel for existing approved messages
    console.log('\n[AutoCode] Scanning for pending approved requests...');
    const pendingRequests = await this.discord.scanChannelForApprovedMessages();

    if (pendingRequests.length > 0) {
      console.log(`[AutoCode] Found ${pendingRequests.length} pending requests, processing...`);
      for (const request of pendingRequests) {
        this.requestQueue.push(request);
      }
      // Start processing queue
      await this.processQueue();
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
    console.log(`[AutoCode] Request ${request.id} added to queue (${this.requestQueue.length} pending)`);

    // Process queue if not already processing
    if (!this.isProcessing) {
      await this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()!;
      await this.processRequest(request);
    }

    this.isProcessing = false;
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

      // Step 2: Clone repository
      console.log('\n[Step 2] Cloning repository with submodules...');
      const repoPath = await this.gitManager.clone(this.config.gitlab.repoUrl, workspace);

      // Step 3: Create feature branch
      console.log('\n[Step 3] Creating feature branch...');
      const branchName = `autocode/${request.id}-${Date.now()}`;
      await this.gitManager.createBranch(repoPath, branchName);

      // Step 4: Build prompt from request
      console.log('\n[Step 4] Preparing Claude prompt...');
      let fullContent = request.content;
      if (request.threadMessages && request.threadMessages.length > 0) {
        fullContent += '\n\n## Discussion Thread:\n' + request.threadMessages.join('\n');
      }
      const prompt = this.claudeOrchestrator.buildPrompt(fullContent);

      // Step 5: Execute Claude CLI
      console.log('\n[Step 5] Executing Claude CLI...');
      const claudeResult = await this.claudeOrchestrator.executeTask(repoPath, prompt);

      if (!claudeResult.success) {
        throw new Error(`Claude execution failed: ${claudeResult.error}`);
      }

      // Step 6: Check for changes and commit
      console.log('\n[Step 6] Committing changes...');
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

      // Step 7: Push to remote
      console.log('\n[Step 7] Pushing to remote...');
      await this.gitManager.push(repoPath, branchName);

      // Step 8: Create Merge Request
      console.log('\n[Step 8] Creating Merge Request...');
      const targetBranch = 'release/stable';
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

      // Step 9: Mark as processed in persistent storage
      await this.storage.markProcessed(request.id);

      // Step 10: Notify Discord
      console.log('\n[Step 10] Notifying Discord...');
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
