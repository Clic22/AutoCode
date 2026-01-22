import { loadConfig, Config } from './config';
import { DiscordBot, CodeRequest } from './discord';
import { WorkspaceManager, Workspace } from './workspace';
import { GitManager } from './git';
import { GitLabClient } from './gitlab';
import { GitLabMonitor, FeedbackRequest } from './gitlab/monitor';
import { ClaudeOrchestrator } from './claude';
import { Storage, WorkspaceInfo, WorkspaceStatus } from './storage';
import path from 'path';
import fs from 'fs/promises';

const MAX_CONCURRENT_REQUESTS = 3;

class AutoCode {
  private config: Config;
  private discord: DiscordBot;
  private workspaceManager: WorkspaceManager;
  private gitManager: GitManager;
  private gitlabClient: GitLabClient;
  private gitlabMonitor: GitLabMonitor;
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
      config.discord.channelIds,
      config.discord.approvalEmoji,
      config.discord.approvedUsers,
      {
        onRequestApproved: this.handleApprovedRequest.bind(this),
      },
      storage
    );

    // Initialize GitLab monitor for MR feedback loop
    this.gitlabMonitor = new GitLabMonitor(
      this.gitlabClient,
      this.storage,
      {
        onFeedbackReceived: this.handleFeedbackReceived.bind(this),
        onValidationApproved: this.handleValidationApproved.bind(this),
      },
      config.gitlab.mrPollingInterval || 60000,
      config.discord.approvedUsers
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
    const incompleteWorkspaces = this.storage.getIncompleteWorkspaces();
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

    // Start GitLab MR monitoring AFTER workspaces are loaded
    // This ensures the first scan picks up any comments on resumed MRs
    console.log('\n[AutoCode] Starting GitLab MR monitoring...');
    await this.gitlabMonitor.startMonitoring();

    console.log('\n[AutoCode] Ready and waiting for new approved requests...');
  }

  private async handleApprovedRequest(request: CodeRequest): Promise<void> {
    // Add to queue
    this.requestQueue.push(request);
    console.log(`[AutoCode] Request ${request.id} added to queue (${this.requestQueue.length} pending, ${this.activeRequests} active)`);

    // Try to process more requests
    this.processNextRequests();
  }

  private async handleFeedbackReceived(feedback: FeedbackRequest): Promise<void> {
    console.log(`[AutoCode] Feedback received for workspace ${feedback.messageId} from ${feedback.author}`);
    console.log(`[AutoCode] Feedback: ${feedback.feedback.substring(0, 200)}...`);

    const workspace = this.storage.getWorkspace(feedback.messageId);
    if (!workspace) {
      console.error(`[AutoCode] Workspace not found for ${feedback.messageId}`);
      try {
        await this.gitlabClient.addMRComment(
          feedback.mrIid,
          '⚠️ Workspace no longer exists, cannot apply feedback.'
        );
      } catch (error) {
        console.error('[AutoCode] Failed to reply to MR:', error);
      }
      return;
    }

    // Save feedback to file
    const feedbackFilePath = path.join(workspace.workspacePath, `feedback-${Date.now()}.md`);
    await fs.writeFile(
      feedbackFilePath,
      `# Feedback from ${feedback.author}\n\nReceived: ${feedback.timestamp.toISOString()}\n\n${feedback.feedback}`,
      'utf-8'
    );

    // Update workspace status and reset attempt counter for new feedback cycle
    await this.storage.updateWorkspaceStatus(feedback.messageId, 'mr_feedback_received', {
      lastFeedbackAt: Date.now(),
      feedbackCount: (workspace.feedbackCount || 0) + 1,
      attempt: 1, // Reset attempt counter for new feedback cycle
    });

    // Create CodeRequest for re-processing
    const feedbackRequest: CodeRequest = {
      id: feedback.messageId,
      messageId: feedback.messageId,
      channelId: '',
      content: feedback.feedback,
      author: feedback.author,
      approvedBy: feedback.author,
      timestamp: feedback.timestamp,
    };

    // Add to queue
    this.requestQueue.push(feedbackRequest);
    console.log(`[AutoCode] Feedback request ${feedback.messageId} added to queue`);

    // Try to process
    this.processNextRequests();
  }

  private async handleValidationApproved(messageId: string): Promise<void> {
    console.log(`[AutoCode] Validation approved for workspace ${messageId}`);

    const workspace = this.storage.getWorkspace(messageId);
    if (!workspace) {
      console.error(`[AutoCode] Workspace not found for ${messageId}`);
      return;
    }

    // Mark as completed
    await this.storage.updateWorkspaceStatus(messageId, 'completed');
    await this.storage.markProcessed(messageId);

    console.log(`[AutoCode] ✅ Workspace ${messageId} completed and validated`);
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

        // Verify workspace still exists on disk
        const workspaceExists = await this.directoryExists(workspaceInfo.workspacePath);
        const repoExists = await this.directoryExists(workspaceInfo.repoPath);

        if (!workspaceExists || !repoExists) {
          console.log(`${getLogPrefix()} Workspace directory missing, will recreate...`);
          await this.storage.deleteWorkspace(request.id);
          workspaceInfo = undefined;
          branchName = '';
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

      if (!workspaceInfo) {
        // Create new workspace
        console.log(`\n${getLogPrefix()} [Step 1] Creating workspace...`);
        workspace = await this.workspaceManager.create(request.id);

        branchName = this.generateBranchName(request.content);
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
    const needsAnalysis = ['created', 'analysis'].includes(initialStatus);
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

        log(`[Phase 3] QA Review (Attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const reviewResult = await this.claudeOrchestrator.reviewImplementation(repoPath, developmentPrompt, branchName);

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
          log('Preparing retry with feedback...');
          previousFeedback = this.buildFeedbackForRetry(reviewResult);
          attempt++;
        } else {
          log('⚠️ Max attempts reached. Proceeding with last implementation.');
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
      const targetBranch = 'release/preview';

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

      // Add MR to indexes for feedback loop
      await this.storage.addMrUrlIndex(mrResult.webUrl, request.id);
      await this.storage.addBranchIndex(branchName, request.id);
    }

    // After MR creation, don't mark as completed yet - wait for feedback loop
    // The GitLabMonitor will handle the feedback loop and eventual completion
    if (workspaceInfo.status === 'mr_created') {
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
