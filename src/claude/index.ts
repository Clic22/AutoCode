import { spawn } from 'child_process';
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

  async executeTask(repoPath: string, prompt: string): Promise<ClaudeResult> {
    console.log(`[Claude] Executing task in: ${repoPath}`);
    console.log(`[Claude] Prompt: ${prompt.substring(0, 100)}...`);

    return new Promise((resolve) => {
      const args = [
        '--print',           // Non-interactive mode, print output
        '--dangerously-skip-permissions',  // Skip permission prompts for automation
        prompt,
      ];

      const proc = spawn(this.cliPath, args, {
        cwd: repoPath,
        shell: true,
        env: {
          ...process.env,
          // Ensure Claude uses the correct working directory
          PWD: repoPath,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(`[Claude] ${text}`);
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(`[Claude Error] ${text}`);
      });

      proc.on('close', (code) => {
        console.log(`[Claude] Process exited with code: ${code}`);

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

  buildPrompt(discordMessage: string, context?: string): string {
    let prompt = `You are working on implementing a feature request from Discord.

## Feature Request:
${discordMessage}
`;

    if (context) {
      prompt += `
## Additional Context:
${context}
`;
    }

    prompt += `
## Instructions:
1. Analyze the feature request carefully
2. Implement the requested changes
3. Make sure the code compiles and follows the project's coding standards
4. Test your changes if possible
5. Keep the changes focused on the requested feature

Please implement this feature now.`;

    return prompt;
  }
}
