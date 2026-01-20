import simpleGit, { SimpleGit } from 'simple-git';
import path from 'path';
import { Workspace } from '../workspace';

export interface GitOperations {
  clone(repoUrl: string, workspace: Workspace): Promise<string>;
  createBranch(repoPath: string, branchName: string): Promise<void>;
  commitAll(repoPath: string, message: string): Promise<void>;
  push(repoPath: string, branchName: string): Promise<void>;
}

export class GitManager implements GitOperations {
  private gitlabToken: string;

  constructor(gitlabToken: string) {
    this.gitlabToken = gitlabToken;
  }

  private getAuthenticatedUrl(repoUrl: string): string {
    // Convert http://gitlab.totemmedia.com/Stephane/qtvghd.git
    // to http://oauth2:TOKEN@gitlab.totemmedia.com/Stephane/qtvghd.git
    const url = new URL(repoUrl);
    url.username = 'oauth2';
    url.password = this.gitlabToken;
    return url.toString();
  }

  async clone(repoUrl: string, workspace: Workspace): Promise<string> {
    const git = simpleGit({ progress: this.logProgress.bind(this) });
    const repoPath = path.join(workspace.path, 'repo');
    const authUrl = this.getAuthenticatedUrl(repoUrl);

    console.log(`[Git] Cloning repository to: ${repoPath}`);
    console.log(`[Git] This may take a while for large repos with submodules...`);

    // Clone with submodules
    await git.clone(authUrl, repoPath, [
      '--recurse-submodules',
      '--shallow-submodules',
      '--progress',
    ]);
    console.log(`[Git] Clone complete`);

    // Initialize submodules if any were missed
    console.log(`[Git] Updating submodules...`);
    const repoGit = simpleGit(repoPath, { progress: this.logProgress.bind(this) });
    await repoGit.submoduleUpdate(['--init', '--recursive']);
    console.log(`[Git] Submodules updated`);

    // Checkout release/preview branch
    console.log(`[Git] Checking out release/preview branch...`);
    await repoGit.checkout('release/preview');
    await repoGit.submoduleUpdate(['--init', '--recursive']);

    console.log(`[Git] Repository cloned with submodules on release/preview branch`);
    return repoPath;
  }

  private logProgress(event: { method: string; stage: string; progress: number }): void {
    if (event.progress) {
      process.stdout.write(`\r[Git] ${event.method} ${event.stage}: ${event.progress}%   `);
      if (event.progress === 100) {
        console.log('');
      }
    }
  }

  async createBranch(repoPath: string, branchName: string): Promise<void> {
    const git = simpleGit(repoPath);

    // Create and checkout new branch
    await git.checkoutLocalBranch(branchName);
    console.log(`[Git] Created and checked out branch: ${branchName}`);
  }

  async commitAll(repoPath: string, message: string): Promise<void> {
    const git = simpleGit(repoPath);

    // Stage all changes
    await git.add('.');

    // Check if there are changes to commit
    const status = await git.status();
    if (status.staged.length === 0 && status.files.length === 0) {
      console.log('[Git] No changes to commit');
      return;
    }

    // Commit
    await git.commit(message);
    console.log(`[Git] Committed changes: ${message}`);
  }

  async push(repoPath: string, branchName: string): Promise<void> {
    const git = simpleGit(repoPath);

    await git.push('origin', branchName, ['--set-upstream']);
    console.log(`[Git] Pushed branch: ${branchName}`);
  }

  async hasChanges(repoPath: string): Promise<boolean> {
    const git = simpleGit(repoPath);
    const status = await git.status();
    return status.files.length > 0;
  }
}
