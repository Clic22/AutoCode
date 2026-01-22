import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ReviewResult {
  approved: boolean;
  feedback: string;
  issues: string[];
}

const MAX_IMPLEMENTATION_ATTEMPTS = 3;

export class ClaudeOrchestrator {
  private cliPath: string;

  constructor(cliPath: string = 'claude') {
    this.cliPath = cliPath;
  }

  /**
   * Phase 1: Analyze the Discord conversation and generate a clear development prompt
   */
  async analyzeRequest(
    repoPath: string,
    discordContent: string,
    threadMessages?: string[],
    branchName?: string
  ): Promise<ClaudeResult> {
    const log = (msg: string) => console.log(branchName ? `[${branchName}] ${msg}` : `[Claude] ${msg}`);
    log('Starting analysis (Phase 1)...');
    const analysisPrompt = this.buildAnalysisPrompt(discordContent, threadMessages);
    return this.execute(repoPath, analysisPrompt, branchName);
  }

  /**
   * Phase 2: Implement the feature based on the refined prompt
   */
  async implementFeature(
    repoPath: string,
    developmentPrompt: string,
    previousFeedback?: string,
    branchName?: string
  ): Promise<ClaudeResult> {
    const log = (msg: string) => console.log(branchName ? `[${branchName}] ${msg}` : `[Claude] ${msg}`);
    log('Starting implementation (Phase 2)...');
    const implementationPrompt = this.buildImplementationPrompt(developmentPrompt, previousFeedback);
    return this.execute(repoPath, implementationPrompt, branchName);
  }

  /**
   * Phase 3: QA Review - Check code quality, potential issues, and alignment with requirements
   */
  async reviewImplementation(
    repoPath: string,
    developmentPrompt: string,
    branchName?: string
  ): Promise<ReviewResult> {
    const log = (msg: string) => console.log(branchName ? `[${branchName}] ${msg}` : `[Claude] ${msg}`);
    log('Starting QA review (Phase 3)...');
    const reviewPrompt = this.buildReviewPrompt(developmentPrompt);
    const result = await this.execute(repoPath, reviewPrompt, branchName);

    if (!result.success) {
      return {
        approved: false,
        feedback: 'Review failed to execute',
        issues: [result.error || 'Unknown error'],
      };
    }

    return this.parseReviewResult(result.output);
  }

  /**
   * Full three-phase execution with review loop (legacy method, kept for compatibility)
   */
  async executeTask(
    repoPath: string,
    discordContent: string,
    threadMessages?: string[],
    workspacePath?: string,
    branchName?: string
  ): Promise<ClaudeResult> {
    const log = (msg: string) => console.log(branchName ? `[${branchName}] ${msg}` : `[Claude] ${msg}`);

    // Phase 1: Analysis
    console.log('\n' + '='.repeat(50));
    log('PHASE 1: Analyzing request...');
    console.log('='.repeat(50));

    const analysisResult = await this.analyzeRequest(repoPath, discordContent, threadMessages, branchName);

    if (!analysisResult.success) {
      log('Phase 1 failed');
      return analysisResult;
    }

    const developmentPrompt = analysisResult.output.trim();

    // Save the development prompt to a file in the workspace
    const promptFilePath = path.join(workspacePath || path.dirname(repoPath), 'development-prompt.md');
    await this.savePromptToFile(promptFilePath, developmentPrompt, discordContent, threadMessages);
    log(`Development prompt saved to: ${promptFilePath}`);

    log('Generated development prompt:');
    console.log('-'.repeat(40));
    console.log(developmentPrompt.substring(0, 500) + (developmentPrompt.length > 500 ? '...' : ''));
    console.log('-'.repeat(40));

    // Implementation and Review Loop
    let attempt = 1;
    let previousFeedback: string | undefined;
    let implementationResult: ClaudeResult = { success: false, output: '', error: 'No implementation attempted' };

    while (attempt <= MAX_IMPLEMENTATION_ATTEMPTS) {
      // Phase 2: Implementation
      console.log('\n' + '='.repeat(50));
      log(`PHASE 2: Implementing feature (Attempt ${attempt}/${MAX_IMPLEMENTATION_ATTEMPTS})...`);
      console.log('='.repeat(50));

      implementationResult = await this.implementFeature(repoPath, developmentPrompt, previousFeedback, branchName);

      if (!implementationResult.success) {
        log('Phase 2 failed');
        return implementationResult;
      }

      // Phase 3: QA Review
      console.log('\n' + '='.repeat(50));
      log(`PHASE 3: QA Review (Attempt ${attempt}/${MAX_IMPLEMENTATION_ATTEMPTS})...`);
      console.log('='.repeat(50));

      const reviewResult = await this.reviewImplementation(repoPath, developmentPrompt, branchName);

      // Save review result
      const reviewFilePath = path.join(workspacePath || path.dirname(repoPath), `review-attempt-${attempt}.md`);
      await this.saveReviewToFile(reviewFilePath, reviewResult, attempt);

      if (reviewResult.approved) {
        log('✅ QA Review PASSED - Implementation approved!');
        return implementationResult;
      }

      log('❌ QA Review FAILED - Issues found:');
      reviewResult.issues.forEach((issue, i) => {
        console.log(`  ${i + 1}. ${issue}`);
      });

      if (attempt < MAX_IMPLEMENTATION_ATTEMPTS) {
        log('Preparing to re-implement with feedback...');
        previousFeedback = this.buildFeedbackForRetry(reviewResult);
      }

      attempt++;
    }

    log(`⚠️ Max attempts (${MAX_IMPLEMENTATION_ATTEMPTS}) reached. Proceeding with last implementation.`);
    return implementationResult;
  }

  private parseReviewResult(output: string): ReviewResult {
    const outputLower = output.toLowerCase();

    // Look for explicit approval/rejection markers
    const hasApproved = outputLower.includes('**approved**') ||
                        outputLower.includes('status: approved') ||
                        outputLower.includes('review: approved') ||
                        (outputLower.includes('approved') && !outputLower.includes('not approved'));

    const hasRejected = outputLower.includes('**rejected**') ||
                        outputLower.includes('status: rejected') ||
                        outputLower.includes('review: rejected') ||
                        outputLower.includes('not approved');

    // Extract issues - look for numbered lists or bullet points after "issues" or "problems"
    const issues: string[] = [];
    const issuePatterns = [
      /(?:issues?|problems?|concerns?|bugs?|errors?)[:\s]*\n((?:[-*\d.]+\s*.+\n?)+)/gi,
      /(?:must fix|needs? fix|should fix|critical|high priority)[:\s]*(.+)/gi,
    ];

    for (const pattern of issuePatterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        const issueBlock = match[1];
        const lines = issueBlock.split('\n').filter(l => l.trim());
        issues.push(...lines.map(l => l.replace(/^[-*\d.]+\s*/, '').trim()).filter(l => l));
      }
    }

    // If we found issues but no clear rejection, consider it rejected
    const approved = hasApproved && !hasRejected && issues.length === 0;

    return {
      approved,
      feedback: output,
      issues: issues.length > 0 ? issues : (approved ? [] : ['Review did not explicitly approve the implementation']),
    };
  }

  private buildFeedbackForRetry(reviewResult: ReviewResult): string {
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

  private async savePromptToFile(
    filePath: string,
    developmentPrompt: string,
    originalContent: string,
    threadMessages?: string[]
  ): Promise<void> {
    // Only save the generated development prompt - keep it concise
    const content = `# AutoCode Development Prompt

Generated: ${new Date().toISOString()}

${developmentPrompt}
`;

    await fs.writeFile(filePath, content, 'utf-8');
  }

  private async saveReviewToFile(filePath: string, reviewResult: ReviewResult, attempt: number): Promise<void> {
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

  private buildAnalysisPrompt(discordContent: string, threadMessages?: string[]): string {
    let prompt = `You are a senior software architect analyzing a feature request from Discord.

## Your Task
Analyze the following feature request and discussion, then produce a CLEAR and DETAILED development prompt that another developer (or AI) can use to implement this feature.

## Important Rules
- Do NOT ask any questions
- Do NOT implement anything yet
- Do NOT include any code
- ONLY output the refined development prompt
- Be specific about what needs to be done
- Include acceptance criteria if possible
- Clarify any ambiguities based on context clues in the discussion

## Original Feature Request:
${discordContent}
`;

    if (threadMessages && threadMessages.length > 0) {
      prompt += `
## Discussion Thread (contains clarifications and additional requirements):
${threadMessages.join('\n')}
`;
    }

    prompt += `
## Output Format
Generate a development prompt with the following structure:

### Feature Summary
[One paragraph summary of what needs to be built]

### Requirements
[Numbered list of specific requirements]

### Technical Details
[Any technical specifications, constraints, or implementation hints gathered from the discussion]

### Acceptance Criteria
[How to verify the feature is complete]

### Files Likely to Modify
[If you can infer from the discussion which parts of the codebase might be affected]

---
Now analyze and generate the development prompt:`;

    return prompt;
  }

  private buildImplementationPrompt(developmentPrompt: string, previousFeedback?: string): string {
    let prompt = `You are a senior developer implementing a feature.

## Development Requirements
${developmentPrompt}
`;

    if (previousFeedback) {
      prompt += `
${previousFeedback}
`;
    }

    prompt += `
## Implementation Instructions
1. Read and understand the requirements above carefully
2. Explore the codebase to understand the existing architecture
3. Implement the feature following the project's coding standards
4. Make sure your code compiles and integrates well with existing code
5. Keep changes focused and minimal - only modify what's necessary
6. Add appropriate comments for complex logic

## Important
- Do NOT ask questions - make reasonable decisions based on the codebase
- If something is ambiguous, choose the most logical interpretation
- Follow existing patterns in the codebase
- Test your changes if possible

Please implement this feature now.`;

    return prompt;
  }

  private buildReviewPrompt(developmentPrompt: string): string {
    return `You are a senior QA engineer and code reviewer. Your job is to review the implementation that was just made.

## Original Requirements
${developmentPrompt}

## Your Task
Review ALL the changes that were made in this repository. Use git diff or explore the modified files to understand what was implemented.

## Review Criteria
Check for the following:

### 1. Crashes & Stability
- Null pointer / undefined access risks
- Unhandled exceptions
- Resource leaks (memory, file handles, connections)
- Race conditions or threading issues

### 2. Performance
- Inefficient algorithms (O(n²) where O(n) is possible)
- Unnecessary loops or redundant operations
- Memory inefficiencies
- Blocking operations in async contexts

### 3. Requirements Alignment
- Does the implementation match ALL the requirements?
- Are there missing features?
- Are there extra features that weren't requested?

### 4. Code Quality
- Does it follow the existing code style?
- Are there obvious bugs or logic errors?
- Is the code maintainable?

## Output Format
You MUST output your review in this exact format:

### Review Status
**APPROVED** or **REJECTED**

### Issues Found
[If REJECTED, list ALL issues that must be fixed, numbered]

### Recommendations
[Optional improvements that are not blocking]

### Summary
[Brief summary of your review]

---
Now review the implementation:`;
  }

  private async execute(repoPath: string, prompt: string, branchName?: string, retryCount: number = 0): Promise<ClaudeResult> {
    const log = (msg: string) => console.log(branchName ? `[${branchName}] ${msg}` : `[Claude] ${msg}`);
    const MAX_RETRIES = 2;

    // Write prompt to a temporary file for debugging
    const promptFile = path.join(repoPath, '.autocode-prompt.txt');
    await fs.writeFile(promptFile, prompt, 'utf-8');

    log(`Starting CLI in: ${repoPath}`);
    log(`Prompt length: ${prompt.length} characters`);
    if (retryCount > 0) {
      log(`Retry attempt ${retryCount}/${MAX_RETRIES}`);
    }

    return new Promise((resolve) => {
      const args = ['--print', '--dangerously-skip-permissions'];

      log(`Executing: ${this.cliPath} ${args.join(' ')}`);

      const proc = spawn(this.cliPath, args, {
        cwd: repoPath,
        shell: true,  // Need shell to resolve PATH
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PWD: repoPath,
        },
      });

      let stdout = '';
      let stderr = '';

      // Write prompt directly to stdin then close it
      proc.stdin.write(prompt, 'utf-8', () => {
        proc.stdin.end();
      });

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        // Prefix output with branch name
        const prefixedText = branchName
          ? text.split('\n').map(line => line ? `[${branchName}] ${line}` : '').join('\n')
          : text;
        process.stdout.write(prefixedText);
      });

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        // Always log errors that contain "Error:" or "No messages"
        const isError = text.includes('Error:') || text.includes('No messages') || text.includes('rejected');
        // Filter out UI noise but always show errors
        if (text.trim() && (isError || (!text.includes('─') && !text.includes('│') && !text.includes('╭') && !text.includes('╰')))) {
          log(`stderr: ${text.trim()}`);
        }
      });

      proc.on('close', async (code) => {
        // Clean up prompt file
        try {
          await fs.unlink(promptFile);
        } catch {
          // Ignore cleanup errors
        }

        log(`Process exited with code: ${code}`);
        log(`stdout length: ${stdout.length} characters`);
        log(`stderr length: ${stderr.length} characters`);

        // Check for "No messages returned" error in stderr
        const hasNoMessagesError = stderr.includes('No messages returned') || stderr.includes('Error: No messages returned');

        // Check if output is empty or too short (less than 50 chars is suspicious)
        const outputTooShort = stdout.trim().length < 50;

        if (code === 0 && !hasNoMessagesError && !outputTooShort) {
          resolve({
            success: true,
            output: stdout,
          });
        } else {
          const errorMessage = hasNoMessagesError
            ? 'Claude CLI returned "No messages returned" - this usually means the prompt was too large, malformed, or there was a network issue'
            : outputTooShort
            ? `Claude CLI output too short (${stdout.trim().length} chars) - likely failed silently`
            : stderr || `Process exited with code ${code}`;

          // Retry logic for transient failures
          if (retryCount < MAX_RETRIES && (hasNoMessagesError || outputTooShort)) {
            log(`⚠️ Detected transient failure, will retry...`);
            log(`Error was: ${errorMessage}`);

            // Wait a bit before retrying (exponential backoff)
            const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
            log(`Waiting ${delay}ms before retry...`);

            setTimeout(async () => {
              const retryResult = await this.execute(repoPath, prompt, branchName, retryCount + 1);
              resolve(retryResult);
            }, delay);
          } else {
            if (retryCount >= MAX_RETRIES) {
              log(`❌ Max retries (${MAX_RETRIES}) reached, giving up`);
            }

            resolve({
              success: false,
              output: stdout,
              error: errorMessage,
            });
          }
        }
      });

      proc.on('error', (error) => {
        log(`Failed to start process: ${error.message}`);
        resolve({
          success: false,
          output: '',
          error: error.message,
        });
      });
    });
  }
}
