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
    const git = simpleGit();
    const repoPath = path.join(workspace.path, 'repo');
    const authUrl = this.getAuthenticatedUrl(repoUrl);

    console.log(`[Git] Cloning repository to: ${repoPath}`);

    // Clone with submodules
    await git.clone(authUrl, repoPath, [
      '--recurse-submodules',
      '--shallow-submodules',
    ]);

    // Initialize submodules if any were missed
    const repoGit = simpleGit(repoPath);
    await repoGit.submoduleUpdate(['--init', '--recursive']);

    console.log(`[Git] Repository cloned with submodules`);
    return repoPath;
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
