import { loadConfig, Config } from './config';
import { DiscordBot, CodeRequest } from './discord';
import { WorkspaceManager, Workspace } from './workspace';
import { GitManager } from './git';
import { GitLabClient } from './gitlab';
import { ClaudeOrchestrator } from './claude';
import { Storage, SupabaseStorage, IStorage, WorkspaceInfo, WorkspaceStatus } from './storage';
import path from 'path';
import fs from 'fs/promises';

const MAX_CONCURRENT_REQUESTS = 3;

class AutoCode {
  private config: Config;
  private discord: DiscordBot;
  private workspaceManager: WorkspaceManager;
  private gitManager: GitManager;
  private gitlabClient: GitLabClient;
  private claudeOrchestrator: ClaudeOrchestrator;
  private storage: IStorage;
  private activeRequests: number = 0;
  private requestQueue: CodeRequest[] = [];

  constructor(config: Config, storage: IStorage) {
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
      config.discord.channelIds,
      config.discord.approvalEmoji,
      config.discord.approvedUsers,
      config.discord.privateChannelIds,
      {
        onRequestApproved: this.handleApprovedRequest.bind(this),
        onIdeationStart: this.handleIdeationStart.bind(this),
        onIdeationResponse: this.handleIdeationResponse.bind(this),
        onPublicChannelApproval: this.handlePublicChannelApproval.bind(this),
        onDiscordFeedback: this.handleDiscordFeedback.bind(this),
        onDiscordValidation: this.handleDiscordValidation.bind(this),
        onBaseBranchResponse: this.handleBaseBranchResponse.bind(this),
        onIdeationApproved: this.handleIdeationApproved.bind(this),
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

    // Check for incomplete workspaces from previous runs BEFORE starting monitor
    // This ensures the monitor can scan for comments on resumed workspaces
    console.log('\n[AutoCode] Checking for incomplete workspaces to resume...');
    const allIncompleteWorkspaces = this.storage.getIncompleteWorkspaces();

    // Filter out workspaces that are waiting for external events, not processing
    // - ideation_pending: transient status during ideation startup
    // - ideation_complete: waiting for approval emoji on Discord
    // - ideation_in_progress: waiting for user response in Discord thread
    // - awaiting_base_branch: waiting for user to select base branch
    // - awaiting_validation: waiting for feedback/approval in Discord thread
    // - mr_created: waiting for feedback/approval in Discord thread
    // Only resume workspaces that are actively being processed
    const waitingStatuses = ['ideation_pending', 'ideation_complete', 'ideation_in_progress', 'awaiting_base_branch', 'awaiting_validation', 'mr_created'];
    const incompleteWorkspaces = allIncompleteWorkspaces.filter(ws => !waitingStatuses.includes(ws.status));

    const waitingWorkspaces = allIncompleteWorkspaces.filter(ws => waitingStatuses.includes(ws.status));
    if (waitingWorkspaces.length > 0) {
      console.log(`[AutoCode] ${waitingWorkspaces.length} workspace(s) waiting for external events:`);
      for (const ws of waitingWorkspaces) {
        console.log(`  - ${ws.messageId}: ${ws.status}`);
      }
    }

    if (incompleteWorkspaces.length > 0) {
      console.log(`[AutoCode] Found ${incompleteWorkspaces.length} incomplete workspace(s) to resume`);
      for (const ws of incompleteWorkspaces) {
        console.log(`  - ${ws.messageId}: status=${ws.status}, branch=${ws.branchName}`);
      }

      // Resume incomplete workspaces by creating CodeRequest objects
      for (const ws of incompleteWorkspaces) {
        const resumeRequest: CodeRequest = {
          id: ws.messageId,
          content: ws.developmentPrompt || 'Resuming from saved workspace',
          author: 'Unknown (resumed)',
          approvedBy: 'Unknown (resumed)',
          channelId: '',
          messageId: ws.messageId,
          threadMessages: [],
          timestamp: new Date(ws.createdAt),
        };
        this.requestQueue.push(resumeRequest);
        console.log(`[AutoCode] Queued workspace ${ws.messageId} for resume`);
      }
    }

    // Scan channel for existing approved messages
    console.log('\n[AutoCode] Scanning for pending approved requests...');
    const pendingRequests = await this.discord.scanChannelForApprovedMessages();

    if (pendingRequests.length > 0) {
      // Filter out requests that are already queued (from incomplete workspaces)
      const queuedIds = new Set(this.requestQueue.map(r => r.id));
      const newRequests = pendingRequests.filter(r => !queuedIds.has(r.id));

      if (newRequests.length > 0) {
        console.log(`[AutoCode] Found ${newRequests.length} new pending request(s)`);
        for (const request of newRequests) {
          this.requestQueue.push(request);
        }
      }
      if (pendingRequests.length !== newRequests.length) {
        console.log(`[AutoCode] Skipped ${pendingRequests.length - newRequests.length} already queued request(s)`);
      }
    }

    // Start processing any queued requests (incomplete workspaces + new requests)
    if (this.requestQueue.length > 0) {
      console.log(`[AutoCode] Processing ${this.requestQueue.length} request(s) in parallel (max ${MAX_CONCURRENT_REQUESTS})...`);
      this.processNextRequests();
    } else {
      console.log('[AutoCode] No pending requests found.');
    }

    // Update last scan timestamp
    await this.storage.updateLastScan();

    console.log('\n[AutoCode] Ready and waiting for new approved requests...');
    console.log('[AutoCode] Feedback will be received via Discord threads (GitLab polling removed)');
  }

  /**
   * Handle ideation start - NEW FLOW: Ask for branch FIRST, then create workspace
   */
  private async handleIdeationStart(
    messageId: string,
    channelId: string,
    threadId: string,
    content: string,
    author: string,
    existingMessages?: string[]
  ): Promise<void> {
    console.log(`[AutoCode] Starting ideation for message ${messageId}`);

    try {
      const branchName = await this.generateBranchName(content);

      // Create workspace tracking with status awaiting_base_branch
      // Workspace will be created AFTER branch selection
      await this.storage.createWorkspace({
        messageId,
        workspacePath: '', // Will be created after branch selection
        branchName,
        repoPath: '', // Will be created after branch selection
        status: 'awaiting_base_branch',  // NEW: Ask for branch first
        attempt: 1,
        threadId,
      });

      // Save initial content for later (when ideation starts)
      const initialConversation = existingMessages && existingMessages.length > 0
        ? existingMessages
        : [`User: ${content}`];

      await this.storage.updateWorkspaceStatus(messageId, 'awaiting_base_branch', {
        ideationConversation: initialConversation,
      });

      // Add thread to index for quick lookup during feedback
      await this.storage.addThreadIndex(threadId, messageId);

      // Ask for base branch FIRST (moved from handleIdeationApproved)
      const branchChoiceMessage = `🌿 **Choix de la branche de base**\n\n` +
        `Avant de commencer l'analyse, sur quelle branche souhaitez-vous baser ce développement ?\n\n` +
        `**Options disponibles :**\n` +
        `1️⃣ \`release/preview\` - Release preview (défaut)\n` +
        `2️⃣ \`release/stable\` - Release stable\n` +
        `3️⃣ \`release/beta\` - Release beta\n` +
        `4️⃣ Autre - Spécifiez une branche personnalisée\n\n` +
        `_Répondez avec le numéro (1, 2, 3) ou tapez directement le nom de la branche._`;

      await this.discord.postToThread(threadId, branchChoiceMessage);
      console.log(`[AutoCode] Posted branch choice message to thread ${threadId}`);

    } catch (error) {
      console.error(`[AutoCode] Error starting ideation:`, error);
      const workspace = this.storage.getWorkspace(messageId);
      if (workspace) {
        await this.storage.updateWorkspaceStatus(messageId, 'failed', {
          lastError: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async handleIdeationResponse(messageId: string, threadId: string, response: string): Promise<void> {
    console.log(`[AutoCode] User response in ideation for ${messageId}`);

    try {
      const workspace = this.storage.getWorkspace(messageId);
      if (!workspace) {
        console.error(`[AutoCode] Workspace not found for ${messageId}`);
        return;
      }

      // Update conversation history
      const conversation = workspace.ideationConversation || [];
      conversation.push(`User: ${response}`);

      await this.storage.updateWorkspaceStatus(messageId, 'ideation_in_progress', {
        ideationConversation: conversation,
        lastIdeationTimestamp: Date.now(),
      });

      // Use workspace.repoPath if available (new flow with early workspace creation)
      // Otherwise fall back to base repo (legacy or edge case)
      const repoPath = workspace.repoPath || this.gitManager.getBaseRepoPath();
      console.log(`[AutoCode] Analyzing conversation using repo: ${repoPath}`);

      const analysisResult = await this.claudeOrchestrator.continueIdeation(
        repoPath,
        conversation
      );

      if (analysisResult.needsMoreInfo && analysisResult.questions) {
        // Claude needs more information - post follow-up questions
        await this.discord.postToThread(threadId, analysisResult.questions);

        conversation.push(`Claude: ${analysisResult.questions}`);
        await this.storage.updateWorkspaceStatus(messageId, 'ideation_in_progress', {
          ideationConversation: conversation,
          lastIdeationTimestamp: Date.now(),
        });

        console.log(`[AutoCode] Posted follow-up questions to thread ${threadId}`);
      } else {
        // Claude is ready - mark ideation as complete
        const readyMessage = `✅ **Ready for Implementation**\n\n${analysisResult.summary || 'I have enough information to proceed.'}\n\nWhen you're ready, add a ✅ reaction to the original message to start implementation.`;

        await this.discord.postToThread(threadId, readyMessage);

        await this.storage.updateWorkspaceStatus(messageId, 'ideation_complete', {
          ideationConversation: conversation,
          lastIdeationTimestamp: Date.now(),
        });

        console.log(`[AutoCode] Ideation complete for ${messageId}, waiting for approval`);
      }
    } catch (error) {
      console.error(`[AutoCode] Error handling ideation response:`, error);
      await this.storage.updateWorkspaceStatus(messageId, 'failed', {
        lastError: error instanceof Error ? error.message : 'Unknown error',
      });

      // Notify user in thread
      try {
        await this.discord.postToThread(threadId, `❌ An error occurred during ideation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } catch {}
    }
  }

  /**
   * Handle approval emoji on a message in a PUBLIC channel
   * This creates a thread in the private channel for ideation
   */
  private async handlePublicChannelApproval(
    sourceMessageId: string,
    sourceChannelId: string,
    content: string,
    author: string,
    threadMessages: string[],
    approvedBy: string
  ): Promise<void> {
    console.log(`[AutoCode] Public channel approval for message ${sourceMessageId}`);
    console.log(`[AutoCode] Content: ${content.substring(0, 200)}...`);

    try {
      // Double-check deduplication (in case processed between detection and handling)
      const existingWorkspace = this.storage.getWorkspaceBySourceMessage(sourceMessageId);
      if (existingWorkspace) {
        console.log(`[AutoCode] Workspace already exists for source message ${sourceMessageId}, skipping`);
        return;
      }

      // Generate a smart title for the conversation
      console.log(`[AutoCode] Generating conversation title...`);
      let conversationTitle: string | undefined;
      try {
        const generatedTitle = await this.claudeOrchestrator.generateConversationTitle(
          this.config.workspacesDir,
          content
        );
        if (generatedTitle) {
          conversationTitle = generatedTitle;
          console.log(`[AutoCode] Generated title: ${conversationTitle}`);
        }
      } catch (error) {
        console.log(`[AutoCode] Could not generate title, will use fallback:`, error);
      }

      // Create thread in private channel
      console.log(`[AutoCode] Creating thread in private channel...`);
      const { threadId, starterMessageId } = await this.discord.createThreadInPrivateChannel(
        content,
        author,
        sourceChannelId,
        threadMessages,
        conversationTitle
      );

      console.log(`[AutoCode] Thread created: ${threadId}, starter message: ${starterMessageId}`);

      // Mark source message as processed
      await this.storage.markProcessed(sourceMessageId);

      // Start ideation with source tracking
      await this.handleIdeationStartWithSource(
        starterMessageId,
        this.config.discord.privateChannelIds[0],
        threadId,
        content,
        author,
        threadMessages.length > 0 ? threadMessages : undefined,
        sourceMessageId,
        sourceChannelId
      );

      // Add to source message index for deduplication
      await this.storage.addSourceMessageIndex(sourceMessageId, starterMessageId);

      console.log(`[AutoCode] Cross-channel ideation started for ${sourceMessageId} -> ${starterMessageId}`);
    } catch (error) {
      console.error(`[AutoCode] Error handling public channel approval:`, error);
    }
  }

  /**
   * Start ideation with source message tracking (for cross-channel flow)
   * NEW FLOW: Ask for branch FIRST, then create workspace
   */
  private async handleIdeationStartWithSource(
    messageId: string,
    channelId: string,
    threadId: string,
    content: string,
    author: string,
    existingMessages?: string[],
    sourceMessageId?: string,
    sourceChannelId?: string
  ): Promise<void> {
    console.log(`[AutoCode] Starting ideation for message ${messageId}${sourceMessageId ? ` (from source ${sourceMessageId})` : ''}`);

    try {
      const branchName = await this.generateBranchName(content);

      // Create workspace tracking with status awaiting_base_branch
      // Workspace will be created AFTER branch selection
      await this.storage.createWorkspace({
        messageId,
        workspacePath: '', // Will be created after branch selection
        branchName,
        repoPath: '', // Will be created after branch selection
        status: 'awaiting_base_branch',  // NEW: Ask for branch first
        attempt: 1,
        threadId,
        sourceMessageId,
        sourceChannelId,
      });

      // Add thread to index for quick lookup during feedback
      await this.storage.addThreadIndex(threadId, messageId);

      // If source message provided, add to index
      if (sourceMessageId) {
        await this.storage.addSourceMessageIndex(sourceMessageId, messageId);
      }

      // Save initial content for later (when ideation starts)
      const initialConversation = existingMessages && existingMessages.length > 0
        ? existingMessages
        : [`User: ${content}`];

      await this.storage.updateWorkspaceStatus(messageId, 'awaiting_base_branch', {
        ideationConversation: initialConversation,
      });

      // Ask for base branch FIRST (moved from handleIdeationApproved)
      const branchChoiceMessage = `🌿 **Choix de la branche de base**\n\n` +
        `Avant de commencer l'analyse, sur quelle branche souhaitez-vous baser ce développement ?\n\n` +
        `**Options disponibles :**\n` +
        `1️⃣ \`release/preview\` - Release preview (défaut)\n` +
        `2️⃣ \`release/stable\` - Release stable\n` +
        `3️⃣ \`release/beta\` - Release beta\n` +
        `4️⃣ Autre - Spécifiez une branche personnalisée\n\n` +
        `_Répondez avec le numéro (1, 2, 3) ou tapez directement le nom de la branche._`;

      await this.discord.postToThread(threadId, branchChoiceMessage);
      console.log(`[AutoCode] Posted branch choice message to thread ${threadId}`);

    } catch (error) {
      console.error(`[AutoCode] Error starting ideation:`, error);
      const workspace = this.storage.getWorkspace(messageId);
      if (workspace) {
        await this.storage.updateWorkspaceStatus(messageId, 'failed', {
          lastError: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private async handleApprovedRequest(request: CodeRequest): Promise<void> {
    // Add to queue
    this.requestQueue.push(request);
    console.log(`[AutoCode] Request ${request.id} added to queue (${this.requestQueue.length} pending, ${this.activeRequests} active)`);

    // Try to process more requests
    this.processNextRequests();
  }

  /**
   * Handle feedback received via Discord thread (replaces GitLab MR polling)
   */
  private async handleDiscordFeedback(
    messageId: string,
    threadId: string,
    feedback: string,
    author: string
  ): Promise<void> {
    console.log(`[AutoCode] Discord feedback received for workspace ${messageId} from ${author}`);
    console.log(`[AutoCode] Feedback: ${feedback.substring(0, 200)}...`);

    const workspace = this.storage.getWorkspace(messageId);
    if (!workspace) {
      console.error(`[AutoCode] Workspace not found for ${messageId}`);
      return;
    }

    // Check if workspace is in a state that can receive feedback
    if (!['mr_created', 'awaiting_validation'].includes(workspace.status)) {
      console.log(`[AutoCode] Workspace ${messageId} is in status ${workspace.status}, ignoring feedback`);
      return;
    }

    // Save feedback to file (if workspace directory exists)
    if (workspace.workspacePath) {
      try {
        const feedbackFilePath = path.join(workspace.workspacePath, `feedback-${Date.now()}.md`);
        await fs.writeFile(
          feedbackFilePath,
          `# Feedback from ${author}\n\nReceived: ${new Date().toISOString()}\n\n${feedback}`,
          'utf-8'
        );
      } catch (error) {
        console.warn(`[AutoCode] Could not save feedback file: ${error}`);
        // Continue anyway - feedback is in the request content
      }
    }

    // Update workspace status and reset attempt counter for new feedback cycle
    await this.storage.updateWorkspaceStatus(messageId, 'mr_feedback_received', {
      lastFeedbackAt: Date.now(),
      feedbackCount: (workspace.feedbackCount || 0) + 1,
      attempt: 1, // Reset attempt counter for new feedback cycle
    });

    await this.notifyThread(messageId,
      `💬 **Feedback reçu**\n\n` +
      `Je prends en compte le retour de ${author}.\n` +
      `Je vais implémenter les modifications et mettre à jour la MR.`
    );

    // Create CodeRequest for re-processing
    const feedbackRequest: CodeRequest = {
      id: messageId,
      messageId: messageId,
      channelId: '',
      content: feedback,
      author: author,
      approvedBy: author,
      timestamp: new Date(),
    };

    // Add to queue
    this.requestQueue.push(feedbackRequest);
    console.log(`[AutoCode] Discord feedback request ${messageId} added to queue`);

    // Try to process
    this.processNextRequests();
  }

  /**
   * Handle validation/approval received via Discord thread (replaces GitLab MR polling)
   */
  private async handleDiscordValidation(messageId: string): Promise<void> {
    console.log(`[AutoCode] Discord validation approved for workspace ${messageId}`);

    const workspace = this.storage.getWorkspace(messageId);
    if (!workspace) {
      console.error(`[AutoCode] Workspace not found for ${messageId}`);
      return;
    }

    // Check if workspace is in a state that can be validated
    if (!['mr_created', 'awaiting_validation'].includes(workspace.status)) {
      console.log(`[AutoCode] Workspace ${messageId} is in status ${workspace.status}, ignoring validation`);
      return;
    }

    // Mark as completed
    await this.storage.updateWorkspaceStatus(messageId, 'completed');
    await this.storage.markProcessed(messageId);

    // Notify in thread
    await this.notifyThread(messageId,
      `✅ **Validation confirmée !**\n\n` +
      `Le travail sur cette demande est terminé.\n` +
      `La Merge Request peut maintenant être fusionnée.`
    );

    console.log(`[AutoCode] ✅ Workspace ${messageId} completed and validated via Discord`);
  }

  /**
   * Handle ideation approval - Branch already selected, proceed directly to implementation
   * NEW FLOW: No longer asks for branch (already selected at the beginning)
   */
  private async handleIdeationApproved(messageId: string, threadId: string): Promise<void> {
    console.log(`[AutoCode] Ideation approved for workspace ${messageId}`);

    const workspace = this.storage.getWorkspace(messageId);
    if (!workspace) {
      console.error(`[AutoCode] Workspace not found for ${messageId}`);
      return;
    }

    // Branch was already selected at the beginning, workspace already exists
    // Just confirm and queue for processing
    await this.discord.postToThread(threadId,
      `✅ **Idéation approuvée !**\n\n` +
      `Lancement de l'implémentation sur la branche \`${workspace.baseBranch || 'release/preview'}\`...`
    );

    // Update status to ideation_complete (if not already)
    await this.storage.updateWorkspaceStatus(messageId, 'ideation_complete');

    // Create CodeRequest and queue for processing
    const request: CodeRequest = {
      id: messageId,
      messageId: messageId,
      channelId: '',
      content: workspace.ideationConversation?.join('\n\n') || '',
      author: '',
      approvedBy: '',
      timestamp: new Date(),
    };

    this.requestQueue.push(request);
    console.log(`[AutoCode] Request ${messageId} added to queue after ideation approval`);

    // Try to process
    this.processNextRequests();
  }

  /**
   * Handle base branch response from user
   * NEW FLOW: Create workspace and START ideation (not queue for implementation)
   */
  private async handleBaseBranchResponse(
    messageId: string,
    threadId: string,
    baseBranch: string,
    author: string
  ): Promise<void> {
    console.log(`[AutoCode] Base branch selected for workspace ${messageId}: ${baseBranch}`);

    const workspace = this.storage.getWorkspace(messageId);
    if (!workspace) {
      console.error(`[AutoCode] Workspace not found for ${messageId}`);
      return;
    }

    // Check if workspace is in the correct status
    if (workspace.status !== 'awaiting_base_branch') {
      console.log(`[AutoCode] Workspace ${messageId} is not awaiting base branch (status: ${workspace.status})`);
      return;
    }

    // Confirm the choice
    await this.discord.postToThread(threadId,
      `✅ **Branche de base sélectionnée :** \`${baseBranch}\`\n\n` +
      `Création du workspace et analyse en cours...`
    );

    try {
      // CREATE THE WORKSPACE NOW on the selected branch
      const workspaceObj = await this.workspaceManager.create(messageId);
      const repoPath = await this.gitManager.createWorktree(
        workspaceObj,
        workspace.branchName,
        baseBranch  // Use selected base branch
      );

      // Update workspace with paths and baseBranch
      await this.storage.updateWorkspaceStatus(messageId, 'ideation_pending', {
        workspacePath: workspaceObj.path,
        repoPath,
        baseBranch,
      });

      console.log(`[AutoCode] Workspace created at ${workspaceObj.path} with repo at ${repoPath}`);

      // Now start ideation with the real workspace path (for code exploration)
      await this.startIdeationWithExploration(
        messageId,
        threadId,
        repoPath,
        workspace.ideationConversation || []
      );

    } catch (error) {
      console.error(`[AutoCode] Error creating workspace:`, error);
      await this.discord.postToThread(threadId, `❌ Erreur lors de la création du workspace: ${error}`);
      await this.storage.updateWorkspaceStatus(messageId, 'failed', {
        lastError: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Start ideation with code exploration - uses the real workspace for exploration
   */
  private async startIdeationWithExploration(
    messageId: string,
    threadId: string,
    repoPath: string,
    existingMessages: string[]
  ): Promise<void> {
    console.log(`[AutoCode] Starting ideation with code exploration on ${repoPath}`);

    try {
      await this.storage.updateWorkspaceStatus(messageId, 'ideation_in_progress', {
        ideationConversation: existingMessages,
        lastIdeationTimestamp: Date.now(),
      });

      // If we have existing messages (from cross-channel flow), analyze them
      if (existingMessages.length > 1) {
        console.log(`[AutoCode] Analyzing existing conversation with ${existingMessages.length} messages...`);
        const analysisResult = await this.claudeOrchestrator.continueIdeation(
          repoPath,
          existingMessages
        );

        if (!analysisResult.needsMoreInfo) {
          // We have enough info, move to approval
          console.log(`[AutoCode] Existing conversation is sufficient, ready for approval`);

          const conversation = [...existingMessages];
          const summaryMessage = `Claude: ✅ Based on our conversation, I have enough information to proceed.\n\n**Summary:**\n${analysisResult.summary}`;
          conversation.push(summaryMessage);

          await this.storage.updateWorkspaceStatus(messageId, 'ideation_complete', {
            ideationConversation: conversation,
          });

          await this.discord.postToThread(
            threadId,
            `${summaryMessage}\n\nReact with ✅ to approve and start implementation.`
          );
          return;
        } else if (analysisResult.questions) {
          // Need more info, ask additional questions
          console.log(`[AutoCode] Need more information, asking follow-up questions...`);
          await this.discord.postToThread(threadId, analysisResult.questions);

          const conversation = [...existingMessages];
          conversation.push(`Claude: ${analysisResult.questions}`);
          await this.storage.updateWorkspaceStatus(messageId, 'ideation_in_progress', {
            ideationConversation: conversation,
          });
          return;
        }
      }

      // Start fresh ideation - ask initial questions using the workspace repo (for code exploration)
      console.log(`[AutoCode] Asking Claude for clarifying questions (with code exploration)...`);
      const userMessage = existingMessages.length > 0
        ? existingMessages[0].replace(/^User:\s*/, '')
        : '';
      const ideationResult = await this.claudeOrchestrator.startIdeation(repoPath, userMessage);

      if (!ideationResult.success) {
        throw new Error(`Ideation failed: ${ideationResult.error}`);
      }

      // Post Claude's questions to the thread
      await this.discord.postToThread(threadId, ideationResult.output);

      // Update conversation history
      const conversation = [...existingMessages];
      conversation.push(`Claude: ${ideationResult.output}`);

      await this.storage.updateWorkspaceStatus(messageId, 'ideation_in_progress', {
        ideationConversation: conversation,
        lastIdeationTimestamp: Date.now(),
      });

      console.log(`[AutoCode] Posted questions to thread ${threadId}`);
    } catch (error) {
      console.error(`[AutoCode] Error during ideation with exploration:`, error);
      await this.storage.updateWorkspaceStatus(messageId, 'failed', {
        lastError: error instanceof Error ? error.message : 'Unknown error',
      });

      try {
        await this.discord.postToThread(threadId, `❌ An error occurred during ideation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } catch {}
    }
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
    // Check if we have an existing workspace for this request
    let workspaceInfo = this.storage.getWorkspace(request.id);
    let workspace: Workspace | null = null;
    let branchName: string = workspaceInfo?.branchName || '';
    let repoPath: string;

    // Create log prefix with branch name
    const getLogPrefix = () => branchName ? `[${branchName}]` : `[${request.id}]`;

    console.log('\n' + '='.repeat(60));
    console.log(`${getLogPrefix()} Processing request: ${request.id}`);
    console.log(`${getLogPrefix()} Content: ${request.content.substring(0, 200)}...`);
    console.log('='.repeat(60));

    try {
      if (workspaceInfo) {
        // Resume from existing workspace
        console.log(`\n${getLogPrefix()} Found existing workspace`);
        console.log(`${getLogPrefix()} Status: ${workspaceInfo.status}, Attempt: ${workspaceInfo.attempt}`);
        console.log(`${getLogPrefix()} Workspace: ${workspaceInfo.workspacePath}`);

        // Check if this is an ideation workspace (no actual workspace created yet)
        if (!workspaceInfo.workspacePath || !workspaceInfo.repoPath) {
          console.log(`${getLogPrefix()} Ideation complete, creating workspace for implementation...`);

          // Create workspace and worktree now
          workspace = await this.workspaceManager.create(request.id);
          branchName = workspaceInfo.branchName;
          // Use the selected base branch if available
          const baseBranch = workspaceInfo.baseBranch;
          if (baseBranch) {
            console.log(`${getLogPrefix()} Using selected base branch: ${baseBranch}`);
          }
          repoPath = await this.gitManager.createWorktree(workspace, branchName, baseBranch);

          // Update workspace info with actual paths
          await this.storage.updateWorkspaceStatus(request.id, workspaceInfo.status, {
            workspacePath: workspace.path,
            repoPath: repoPath,
          });

          // Update the workspaceInfo object
          workspaceInfo.workspacePath = workspace.path;
          workspaceInfo.repoPath = repoPath;

          console.log(`${getLogPrefix()} Workspace created: ${workspace.path}`);
          console.log(`${getLogPrefix()} Worktree created: ${repoPath}`);
        } else {
          // Verify workspace still exists on disk
          const workspaceExists = await this.directoryExists(workspaceInfo.workspacePath);
          const repoExists = await this.directoryExists(workspaceInfo.repoPath);

          if (!workspaceExists || !repoExists) {
            // Don't delete workspaces that are waiting for GitLab events - they don't need the physical directory
            const gitlabWaitingStatuses = ['awaiting_validation', 'mr_created'];
            if (gitlabWaitingStatuses.includes(workspaceInfo.status)) {
              console.log(`${getLogPrefix()} Workspace directory missing but status is ${workspaceInfo.status}, keeping workspace record`);
              // Just continue without the physical workspace - the GitLab monitor will handle it
            } else if (workspaceInfo.branchName) {
              // Try to recover workspace from remote branch (e.g., when syncing across machines)
              console.log(`${getLogPrefix()} Workspace directory missing, trying to recover from remote branch...`);
              try {
                const remoteBranchExists = await this.gitManager.remoteBranchExists(workspaceInfo.branchName);
                if (remoteBranchExists) {
                  console.log(`${getLogPrefix()} Found branch on remote, recreating workspace...`);
                  workspace = await this.workspaceManager.create(request.id);
                  branchName = workspaceInfo.branchName;
                  repoPath = await this.gitManager.createWorktreeFromRemoteBranch(workspace, branchName);

                  // Update workspace info with new paths
                  await this.storage.updateWorkspaceStatus(request.id, workspaceInfo.status, {
                    workspacePath: workspace.path,
                    repoPath: repoPath,
                  });
                  workspaceInfo.workspacePath = workspace.path;
                  workspaceInfo.repoPath = repoPath;

                  console.log(`${getLogPrefix()} Workspace recovered from remote branch`);
                } else {
                  console.log(`${getLogPrefix()} Branch not found on remote, will recreate from scratch...`);
                  await this.storage.deleteWorkspace(request.id);
                  workspaceInfo = undefined;
                  branchName = '';
                }
              } catch (error) {
                console.error(`${getLogPrefix()} Error recovering workspace:`, error);
                await this.storage.deleteWorkspace(request.id);
                workspaceInfo = undefined;
                branchName = '';
              }
            } else {
              console.log(`${getLogPrefix()} Workspace directory missing, will recreate...`);
              await this.storage.deleteWorkspace(request.id);
              workspaceInfo = undefined;
              branchName = '';
            }
          } else {
            workspace = {
              id: request.id,
              path: workspaceInfo.workspacePath,
              requestId: request.id,
              createdAt: new Date(workspaceInfo.createdAt),
            };
            branchName = workspaceInfo.branchName;
            repoPath = workspaceInfo.repoPath;
          }
        }
      }

      if (!workspaceInfo) {
        // Create new workspace
        console.log(`\n${getLogPrefix()} [Step 1] Creating workspace...`);
        workspace = await this.workspaceManager.create(request.id);

        branchName = await this.generateBranchName(request.content);
        console.log(`\n[${branchName}] [Step 2] Creating worktree from base repository...`);
        repoPath = await this.gitManager.createWorktree(workspace, branchName);

        // Track the new workspace
        workspaceInfo = await this.storage.createWorkspace({
          messageId: request.id,
          workspacePath: workspace.path,
          branchName,
          repoPath,
          status: 'created',
          attempt: 1,
        });
      }

      // Resume based on current status
      await this.resumeFromStatus(request, workspaceInfo!, workspace!, branchName!, repoPath!);

    } catch (error) {
      console.error(`${getLogPrefix()} Error processing request:`, error);

      // Update workspace status to failed
      if (workspaceInfo) {
        await this.storage.updateWorkspaceStatus(request.id, 'failed', {
          lastError: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Discord notification disabled for now
      // try {
      //   await this.discord.replyToMessage(
      //     request.channelId,
      //     request.messageId,
      //     `❌ AutoCode encountered an error while processing this request:\n\`\`\`\n${error instanceof Error ? error.message : 'Unknown error'}\n\`\`\``
      //   );
      // } catch (discordError) {
      //   console.error('[AutoCode] Failed to notify Discord of error:', discordError);
      // }
    }
  }

  private async resumeFromStatus(
    request: CodeRequest,
    workspaceInfo: WorkspaceInfo,
    workspace: Workspace,
    branchName: string,
    repoPath: string
  ): Promise<void> {
    const initialStatus = workspaceInfo.status;
    const log = (msg: string) => console.log(`[${branchName}] ${msg}`);

    log(`Resuming from status: ${initialStatus}`);

    // Determine where to resume from
    let developmentPrompt = workspaceInfo.developmentPrompt;

    // Determine which phases need to run based on initial status
    const needsAnalysis = ['created', 'analysis', 'ideation_complete'].includes(initialStatus);
    const needsImplementation = needsAnalysis || ['analysis_done', 'implementation', 'review_failed', 'mr_feedback_received'].includes(initialStatus);
    const needsReview = needsImplementation || ['implementation_done', 'review'].includes(initialStatus);
    const needsCommit = needsReview; // After review, we commit
    const needsPush = ['committed'].includes(initialStatus);
    const needsMR = ['pushed', 'mr_failed'].includes(initialStatus);

    // Handle awaiting_validation status - do nothing, just waiting for approval
    if (initialStatus === 'awaiting_validation') {
      log('Waiting for validation approval from MR comments...');
      return;
    }

    // Handle ideation_in_progress status - waiting for user response in Discord thread
    if (initialStatus === 'ideation_in_progress') {
      log('Ideation in progress - waiting for user response in Discord thread...');
      // TODO: Could re-read thread to check for missed messages, but for now just wait
      return;
    }

    // Handle awaiting_base_branch status - waiting for user to select base branch
    if (initialStatus === 'awaiting_base_branch') {
      log('Waiting for user to select base branch in Discord thread...');
      return;
    }

    // Phase 1: Analysis
    if (needsAnalysis) {
      await this.storage.updateWorkspaceStatus(request.id, 'analysis');

      log('[Phase 1] Analyzing request and generating development prompt...');
      const analysisResult = await this.claudeOrchestrator.analyzeRequest(
        repoPath,
        request.content,
        request.threadMessages,
        branchName
      );

      if (!analysisResult.success) {
        throw new Error(`Analysis failed: ${analysisResult.error}`);
      }

      developmentPrompt = analysisResult.output.trim();

      // Save the development prompt
      const promptFilePath = path.join(workspace.path, 'development-prompt.md');
      await this.savePromptToFile(promptFilePath, developmentPrompt, request.content, request.threadMessages);

      await this.storage.updateWorkspaceStatus(request.id, 'analysis_done', { developmentPrompt });
      log('[Phase 1] Analysis complete. Prompt saved.');
    }

    // Phase 2 & 3: Implementation with review loop
    if (needsImplementation) {
      if (!developmentPrompt) {
        // Try to load from file
        const promptFilePath = path.join(workspace.path, 'development-prompt.md');
        try {
          const content = await fs.readFile(promptFilePath, 'utf-8');
          // Extract just the prompt part (after the header)
          const match = content.match(/Generated: .+\n\n([\s\S]+)$/);
          developmentPrompt = match ? match[1].trim() : content;
        } catch {
          throw new Error('Development prompt not found. Cannot resume implementation.');
        }
      }

      const MAX_ATTEMPTS = 3;
      let attempt = workspaceInfo.attempt || 1;
      let previousFeedback: string | undefined;

      // If we're resuming from a failed review, prepare feedback
      if (initialStatus === 'review_failed') {
        const reviewFilePath = path.join(workspace.path, `review-attempt-${attempt}.md`);
        try {
          const reviewContent = await fs.readFile(reviewFilePath, 'utf-8');
          previousFeedback = this.extractFeedbackFromReview(reviewContent);
          attempt++; // Move to next attempt
        } catch {
          // No previous review found, start fresh
        }
      }

      // If we're resuming from MR feedback, load the feedback
      if (initialStatus === 'mr_feedback_received') {
        // Find the most recent feedback file
        const files = await fs.readdir(workspace.path);
        const feedbackFiles = files
          .filter(f => f.startsWith('feedback-'))
          .sort()
          .reverse();

        if (feedbackFiles.length > 0) {
          const feedbackFilePath = path.join(workspace.path, feedbackFiles[0]);
          const feedbackContent = await fs.readFile(feedbackFilePath, 'utf-8');
          // Extract feedback text (everything after the header)
          const match = feedbackContent.match(/Received: .+\n\n([\s\S]+)$/);
          previousFeedback = match ? match[1].trim() : feedbackContent;
          log(`Using feedback from ${feedbackFiles[0]}`);
        } else {
          log('Warning: No feedback file found, using request content as feedback');
          previousFeedback = request.content;
        }
      }

      while (attempt <= MAX_ATTEMPTS) {
        // Phase 2: Implementation (skip if resuming from implementation_done or review)
        const skipImplementation = !needsAnalysis && ['implementation_done', 'review'].includes(initialStatus) && attempt === 1;

        if (!skipImplementation) {
          await this.storage.updateWorkspaceStatus(request.id, 'implementation', { attempt });

          if (attempt === 1) {
            await this.notifyThread(request.id,
              `🚀 **Début de l'implémentation**\n\n` +
              `Je travaille sur votre demande. Cela peut prendre plusieurs minutes.\n\n` +
              `**Prochaines étapes:**\n` +
              `• Implémentation du code\n` +
              `• Review QA automatique\n` +
              `• Création de la Merge Request\n\n` +
              `Je vous tiendrai informé de l'avancement.`
            );
          } else {
            await this.notifyThread(request.id,
              `🔄 **Nouvelle tentative** (${attempt}/${MAX_ATTEMPTS})\n\n` +
              `La review précédente a trouvé des problèmes. Je corrige et réessaie...`
            );
          }

          log(`[Phase 2] Implementing feature (Attempt ${attempt}/${MAX_ATTEMPTS})...`);
          const implementationResult = await this.claudeOrchestrator.implementFeature(
            repoPath,
            developmentPrompt,
            previousFeedback,
            branchName
          );

          if (!implementationResult.success) {
            throw new Error(`Implementation failed: ${implementationResult.error}`);
          }

          await this.storage.updateWorkspaceStatus(request.id, 'implementation_done');
        }

        // Phase 3: QA Review
        await this.storage.updateWorkspaceStatus(request.id, 'review');

        await this.notifyThread(request.id,
          `🔍 **Review QA en cours**\n\n` +
          `L'implémentation est terminée. Vérification automatique de la qualité...`
        );

        log(`[Phase 3] QA Review (Attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const reviewResult = await this.claudeOrchestrator.reviewImplementation(repoPath, developmentPrompt, previousFeedback, branchName);

        // Save review result
        const reviewFilePath = path.join(workspace.path, `review-attempt-${attempt}.md`);
        await this.saveReviewToFile(reviewFilePath, reviewResult, attempt);

        if (reviewResult.approved) {
          log('[Phase 3] ✅ QA Review PASSED');
          break;
        }

        log('[Phase 3] ❌ QA Review FAILED - Issues found:');
        reviewResult.issues.forEach((issue, i) => {
          console.log(`[${branchName}]   ${i + 1}. ${issue}`);
        });

        await this.storage.updateWorkspaceStatus(request.id, 'review_failed', { attempt });

        if (attempt < MAX_ATTEMPTS) {
          await this.notifyThread(request.id,
            `⚠️ **Review échouée** (Tentative ${attempt}/${MAX_ATTEMPTS})\n\n` +
            `${reviewResult.issues.length} problème(s) détecté(s). Préparation d'une nouvelle tentative...`
          );
          log('Preparing retry with feedback...');
          previousFeedback = this.buildFeedbackForRetry(reviewResult);
          attempt++;
        } else {
          log('⚠️ Max attempts reached. Proceeding with last implementation.');
          await this.notifyThread(request.id,
            `⚠️ **Nombre maximum de tentatives atteint**\n\n` +
            `Après ${MAX_ATTEMPTS} tentatives, certains problèmes peuvent subsister.\n` +
            `Je continue avec l'implémentation actuelle. Merci de bien vérifier la MR.`
          );
          break;
        }
      }
    }

    // Step 4: Commit changes (only if not already committed/pushed)
    if (needsCommit && !needsPush && !needsMR) {
      log('[Step 4] Checking for changes to commit...');
      const hasChanges = await this.gitManager.hasChanges(repoPath);

      if (!hasChanges) {
        // Check if there are already commits on this branch that need to be pushed
        const hasCommitsToPush = await this.gitManager.hasCommitsToPush(repoPath, branchName);
        if (!hasCommitsToPush) {
          log('No changes were made by Claude and no commits to push');
          await this.storage.updateWorkspaceStatus(request.id, 'completed');
          await this.storage.markProcessed(request.id);
          return;
        }
        log('No new changes, but there are commits to push. Skipping commit step.');
        await this.storage.updateWorkspaceStatus(request.id, 'committed');
      } else {
        // Extract a meaningful title from the development prompt
        const featureTitle = this.extractFeatureTitle(developmentPrompt || '', branchName);
        const commitMessage = featureTitle;

        await this.gitManager.commitAll(repoPath, commitMessage);
        await this.storage.updateWorkspaceStatus(request.id, 'committed');
        log('[Step 4] Changes committed.');
      }
    }

    // Step 5: Push to remote (only if not already pushed)
    if ((needsCommit || needsPush) && !needsMR) {
      log('[Step 5] Pushing to remote...');
      await this.gitManager.push(repoPath, branchName);

      // If this is a feedback loop iteration, set status to awaiting_validation
      if (workspaceInfo.mrUrl) {
        await this.storage.updateWorkspaceStatus(request.id, 'awaiting_validation');
        log('Changes pushed. Waiting for feedback or validation on MR...');
        return;
      } else {
        await this.storage.updateWorkspaceStatus(request.id, 'pushed');
      }
    }

    // Step 6: Create Merge Request
    if (needsCommit || needsPush || needsMR) {
      log('[Step 6] Creating Merge Request...');
      // Use the selected base branch as target, or default to release/preview
      const targetBranch = workspaceInfo.baseBranch || 'release/preview';
      if (workspaceInfo.baseBranch) {
        log(`Using selected target branch: ${targetBranch}`);
      }

      // Extract meaningful title and test checklist from development prompt
      const featureTitle = this.extractFeatureTitle(developmentPrompt || '', branchName);
      const testChecklist = this.extractTestChecklist(developmentPrompt || '');
      const featureSummary = this.extractFeatureSummary(developmentPrompt || '');

      const mrResult = await this.gitlabClient.createMergeRequest({
        sourceBranch: branchName,
        targetBranch: targetBranch,
        title: featureTitle,
        description: `## Summary

${featureSummary}

---

## 🧪 Tests à vérifier manuellement

${testChecklist}`,
      });

      await this.storage.updateWorkspaceStatus(request.id, 'mr_created', { mrUrl: mrResult.webUrl });
      log(`[Step 6] MR created: ${mrResult.webUrl}`);

      await this.notifyThread(request.id,
        `✅ **Merge Request créée !**\n\n` +
        `Votre implémentation est prête pour review.\n\n` +
        `🔗 **Lien:** ${mrResult.webUrl}\n\n` +
        `Vous pouvez maintenant:\n` +
        `• Consulter les changements sur GitLab\n` +
        `• Laisser des commentaires si modifications nécessaires\n` +
        `• Approuver quand tout est bon`
      );

      // Add MR to indexes for feedback loop
      await this.storage.addMrUrlIndex(mrResult.webUrl, request.id);
      await this.storage.addBranchIndex(branchName, request.id);
    }

    // After MR creation, don't mark as completed yet - wait for feedback loop
    // The GitLabMonitor will handle the feedback loop and eventual completion
    if (workspaceInfo.status === 'mr_created' || workspaceInfo.status === 'awaiting_validation') {
      log('Waiting for feedback or validation on MR...');
      return;
    }

    // Step 7: Mark as completed
    await this.storage.markProcessed(request.id);
    await this.storage.updateWorkspaceStatus(request.id, 'completed');

    const finalWorkspaceInfo = this.storage.getWorkspace(request.id);
    const mrUrl = finalWorkspaceInfo?.mrUrl;

    console.log('\n' + '='.repeat(60));
    log(`✅ COMPLETED - MR: ${mrUrl || 'N/A'}`);
    console.log('='.repeat(60));
  }

  private async notifyThread(messageId: string, message: string): Promise<void> {
    const workspace = this.storage.getWorkspace(messageId);
    if (!workspace?.threadId) {
      return; // Pas de thread associé, skip silencieusement
    }

    try {
      await this.discord.postToThread(workspace.threadId, message);
    } catch (error) {
      console.error(`[AutoCode] Failed to send Discord notification: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Ne pas faire échouer le workflow pour une erreur de notification
    }
  }

  private async savePromptToFile(
    filePath: string,
    developmentPrompt: string,
    originalContent: string,
    threadMessages?: string[]
  ): Promise<void> {
    const content = `# AutoCode Development Prompt

Generated: ${new Date().toISOString()}

${developmentPrompt}
`;
    await fs.writeFile(filePath, content, 'utf-8');
  }

  private async saveReviewToFile(
    filePath: string,
    reviewResult: { approved: boolean; feedback: string; issues: string[] },
    attempt: number
  ): Promise<void> {
    const content = `# AutoCode QA Review - Attempt ${attempt}

Generated: ${new Date().toISOString()}

## Status: ${reviewResult.approved ? '✅ APPROVED' : '❌ REJECTED'}

## Issues Found
${reviewResult.issues.length > 0 ? reviewResult.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n') : 'No issues found.'}

## Full Review Output

${reviewResult.feedback}
`;
    await fs.writeFile(filePath, content, 'utf-8');
  }

  private extractFeedbackFromReview(reviewContent: string): string {
    // Extract issues from saved review file
    const issuesMatch = reviewContent.match(/## Issues Found\n([\s\S]*?)(?=\n## |$)/);
    if (issuesMatch) {
      return `
## Previous Implementation Review - FAILED

The previous implementation was reviewed and the following issues were found:

${issuesMatch[1].trim()}

## Instructions for This Attempt

Please address ALL the issues listed above.
`;
    }
    return '';
  }

  private buildFeedbackForRetry(reviewResult: { issues: string[] }): string {
    return `
## Previous Implementation Review - FAILED

The previous implementation was reviewed and the following issues were found:

${reviewResult.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## Instructions for This Attempt

Please address ALL the issues listed above. Focus on:
- Fixing any potential crashes or null pointer issues
- Addressing performance concerns
- Ensuring the implementation matches the requirements
- Following coding best practices

Do NOT repeat the same mistakes.
`;
  }

  private extractTestChecklist(developmentPrompt: string): string {
    // Try to find the Acceptance Criteria section
    const acceptanceCriteriaMatch = developmentPrompt.match(
      /### Acceptance Criteria\n([\s\S]*?)(?=\n###|$)/i
    );

    if (acceptanceCriteriaMatch) {
      const criteria = acceptanceCriteriaMatch[1].trim();
      // Convert numbered list or bullet points to checkbox format
      // Only top-level items get checkboxes, sub-items become regular bullet points
      const lines = criteria.split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          // Check if this is an indented sub-item (has leading whitespace)
          const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
          const isSubItem = leadingWhitespace.length > 0;
          const trimmedLine = line.trim();

          // Remove existing checkbox markers and numbering
          let cleaned = trimmedLine
            .replace(/^\d+\.\s*\[[ x]\]\s*/, '')  // Remove "1. [ ]" or "1. [x]"
            .replace(/^\d+\.\s*/, '')              // Remove "1. "
            .replace(/^[-*]\s*\[[ x]\]\s*/, '')   // Remove "- [ ]" or "- [x]"
            .replace(/^[-*]\s*/, '')               // Remove "- " or "* "
            .trim();

          if (cleaned.length > 0) {
            if (isSubItem) {
              // Sub-items get regular bullet points, indented
              return `  - ${cleaned}`;
            }
            // Top-level items get checkboxes
            return `- [ ] ${cleaned}`;
          }
          return '';
        })
        .filter(line => line.length > 0);

      if (lines.length > 0) {
        return lines.join('\n');
      }
    }

    // Try to find Requirements section as fallback
    const requirementsMatch = developmentPrompt.match(
      /### Requirements\n([\s\S]*?)(?=\n###|$)/i
    );

    if (requirementsMatch) {
      const requirements = requirementsMatch[1].trim();
      const lines = requirements.split('\n')
        .filter(line => line.trim().length > 0 && /^[\s]*[\d\-*]/.test(line))
        .map(line => {
          // Check if this is an indented sub-item
          const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
          const isSubItem = leadingWhitespace.length > 0;
          const trimmedLine = line.trim();

          let cleaned = trimmedLine
            .replace(/^\d+\.\s*\*\*([^*]+)\*\*:?\s*/, '$1: ')  // Handle "1. **Title**: desc"
            .replace(/^\d+\.\s*/, '')
            .replace(/^[-*]\s*\[[ x]\]\s*/, '')  // Remove existing checkboxes
            .replace(/^[-*]\s*/, '')
            .trim();

          if (cleaned.length > 0) {
            if (isSubItem) {
              return `  - ${cleaned}`;
            }
            return `- [ ] Vérifier: ${cleaned}`;
          }
          return '';
        })
        .filter(line => line.length > 0);

      if (lines.length > 0) {
        return lines.join('\n');
      }
    }

    // Default checklist if nothing found
    return `- [ ] Vérifier que la fonctionnalité fonctionne comme décrit
- [ ] Vérifier qu'il n'y a pas de régression
- [ ] Tester les cas limites
- [ ] Vérifier la qualité du code`;
  }

  private extractFeatureTitle(developmentPrompt: string, branchName: string): string {
    // Try to find "## Development Prompt: <title>" pattern
    const devPromptMatch = developmentPrompt.match(/##\s*Development Prompt:\s*(.+)/i);
    if (devPromptMatch) {
      return devPromptMatch[1].trim();
    }

    // Try to find "### Feature Summary" and extract first sentence
    const summaryMatch = developmentPrompt.match(/### Feature Summary\n+([^\n]+)/i);
    if (summaryMatch) {
      const summary = summaryMatch[1].trim();
      // Take first sentence or first 80 chars
      const firstSentence = summary.split(/[.!?]/)[0];
      if (firstSentence.length > 80) {
        return firstSentence.substring(0, 77) + '...';
      }
      return firstSentence;
    }

    // Fallback: use branch name formatted nicely
    const branchTitle = branchName
      .replace(/^(feature|fix)\//, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    return branchTitle;
  }

  private extractFeatureSummary(developmentPrompt: string): string {
    // Try to find "### Feature Summary" section
    const summaryMatch = developmentPrompt.match(/### Feature Summary\n+([\s\S]*?)(?=\n###|$)/i);
    if (summaryMatch) {
      return summaryMatch[1].trim();
    }

    // Fallback: try to find any summary-like content at the beginning
    const lines = developmentPrompt.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length > 0) {
      // Take first paragraph
      const firstPara = lines.slice(0, 3).join('\n');
      return firstPara.length > 500 ? firstPara.substring(0, 497) + '...' : firstPara;
    }

    return 'See development prompt for details.';
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async generateBranchName(content: string): Promise<string> {
    // Use workspaces directory instead of base repo since we don't need repo access
    const workspacesDir = this.config.workspacesDir;

    // Try to use Claude to generate a descriptive branch name
    try {
      const result = await this.claudeOrchestrator.generateBranchName(workspacesDir, content);

      if (result) {
        console.log(`[AutoCode] Generated branch name: ${result.branchName}`);
        return result.branchName;
      }
    } catch (error) {
      console.log(`[AutoCode] Failed to generate branch name with Claude, falling back to simple method`);
    }

    // Fallback to original simple method if Claude fails
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
      .substring(0, 50);                       // Limit length

    return `${prefix}/${sanitized}`;
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

  // Initialize storage based on configuration
  let storage: IStorage;
  if (config.storageType === 'supabase' && config.supabase) {
    console.log('[AutoCode] Using Supabase storage');
    storage = new SupabaseStorage(config.supabase);
  } else {
    console.log('[AutoCode] Using JSON file storage');
    const storagePath = path.join(config.workspacesDir, '..', 'autocode-data.json');
    storage = new Storage(storagePath);
  }
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
