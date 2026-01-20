import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
}

export class ClaudeOrchestrator {
  private cliPath: string;

  constructor(cliPath: string = 'claude') {
    this.cliPath = cliPath;
  }

  /**
   * Phase 1: Analyze the Discord conversation and generate a clear development prompt
   */
  async analyzeRequest(repoPath: string, discordContent: string, threadMessages?: string[]): Promise<ClaudeResult> {
    console.log(`[Claude Phase 1] Analyzing request and generating development prompt...`);

    const analysisPrompt = this.buildAnalysisPrompt(discordContent, threadMessages);
    return this.execute(repoPath, analysisPrompt);
  }

  /**
   * Phase 2: Implement the feature based on the refined prompt from Phase 1
   */
  async implementFeature(repoPath: string, developmentPrompt: string): Promise<ClaudeResult> {
    console.log(`[Claude Phase 2] Implementing feature based on analyzed requirements...`);

    const implementationPrompt = this.buildImplementationPrompt(developmentPrompt);
    return this.execute(repoPath, implementationPrompt);
  }

  /**
   * Full two-phase execution
   */
  async executeTask(repoPath: string, discordContent: string, threadMessages?: string[], workspacePath?: string): Promise<ClaudeResult> {
    // Phase 1: Analysis
    console.log('\n' + '='.repeat(40));
    console.log('[Claude] PHASE 1: Analyzing request...');
    console.log('='.repeat(40));

    const analysisResult = await this.analyzeRequest(repoPath, discordContent, threadMessages);

    if (!analysisResult.success) {
      console.error('[Claude] Phase 1 failed');
      return analysisResult;
    }

    const developmentPrompt = analysisResult.output.trim();

    // Save the development prompt to a file in the workspace
    const promptFilePath = path.join(workspacePath || path.dirname(repoPath), 'development-prompt.md');
    await this.savePromptToFile(promptFilePath, developmentPrompt, discordContent, threadMessages);
    console.log(`\n[Claude] Development prompt saved to: ${promptFilePath}`);

    console.log('\n[Claude] Generated development prompt:');
    console.log('-'.repeat(40));
    console.log(developmentPrompt.substring(0, 500) + (developmentPrompt.length > 500 ? '...' : ''));
    console.log('-'.repeat(40));

    // Phase 2: Implementation
    console.log('\n' + '='.repeat(40));
    console.log('[Claude] PHASE 2: Implementing feature...');
    console.log('='.repeat(40));

    const implementationResult = await this.implementFeature(repoPath, developmentPrompt);

    return implementationResult;
  }

  private async savePromptToFile(
    filePath: string,
    developmentPrompt: string,
    originalContent: string,
    threadMessages?: string[]
  ): Promise<void> {
    const content = `# AutoCode Development Prompt

Generated: ${new Date().toISOString()}

## Original Discord Request
${originalContent}

${threadMessages && threadMessages.length > 0 ? `## Discussion Thread
${threadMessages.join('\n')}

` : ''}## Generated Development Prompt

${developmentPrompt}

---
*This file can be used to re-run the implementation with:*
\`\`\`bash
cd repo
claude --print --dangerously-skip-permissions "$(cat ../development-prompt.md)"
\`\`\`
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

  private buildImplementationPrompt(developmentPrompt: string): string {
    return `You are a senior developer implementing a feature.

## Development Requirements
${developmentPrompt}

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
  }

  private execute(repoPath: string, prompt: string): Promise<ClaudeResult> {
    return new Promise((resolve) => {
      const args = [
        '--print',
        '--dangerously-skip-permissions',
        prompt,
      ];

      const proc = spawn(this.cliPath, args, {
        cwd: repoPath,
        shell: true,
        env: {
          ...process.env,
          PWD: repoPath,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(text);
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(`[Claude Error] ${text}`);
      });

      proc.on('close', (code) => {
        console.log(`\n[Claude] Process exited with code: ${code}`);

        if (code === 0) {
          resolve({
            success: true,
            output: stdout,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Process exited with code ${code}`,
          });
        }
      });

      proc.on('error', (error) => {
        console.error(`[Claude] Failed to start process:`, error);
        resolve({
          success: false,
          output: '',
          error: error.message,
        });
      });
    });
  }
}
