import simpleGit, { SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { Workspace } from '../workspace';

export interface GitOperations {
  ensureBaseRepo(): Promise<void>;
  createWorktree(workspace: Workspace, branchName: string): Promise<string>;
  createBranch(repoPath: string, branchName: string): Promise<void>;
  commitAll(repoPath: string, message: string): Promise<void>;
  push(repoPath: string, branchName: string): Promise<void>;
}

export class GitManager implements GitOperations {
  private gitlabToken: string;
  private repoUrl: string;
  private baseRepoPath: string;
  private baseBranch: string;

  constructor(
    gitlabToken: string,
    repoUrl: string,
    workspacesDir: string,
    baseBranch: string = 'release/preview'
  ) {
    this.gitlabToken = gitlabToken;
    this.repoUrl = repoUrl;
    this.baseRepoPath = path.join(workspacesDir, 'base-repo');
    this.baseBranch = baseBranch;
  }

  private getAuthenticatedUrl(repoUrl: string): string {
    const url = new URL(repoUrl);
    url.username = 'oauth2';
    url.password = this.gitlabToken;
    return url.toString();
  }

  /**
   * Ensure the base repository exists and is up to date
   * This is called once at startup
   */
  async ensureBaseRepo(): Promise<void> {
    const authUrl = this.getAuthenticatedUrl(this.repoUrl);

    // Check if base repo exists
    const exists = await this.directoryExists(this.baseRepoPath);

    if (exists) {
      console.log('[Git] Base repo exists, fetching latest changes...');
      const git = simpleGit(this.baseRepoPath);

      try {
        // Fetch all branches and tags
        await git.fetch(['--all', '--prune']);

        // Update submodules
        console.log('[Git] Updating submodules in base repo...');
        await git.submoduleUpdate(['--init', '--recursive']);

        console.log('[Git] Base repo updated successfully');
      } catch (error) {
        console.error('[Git] Error updating base repo, will re-clone:', error);
        await fs.rm(this.baseRepoPath, { recursive: true, force: true });
        await this.cloneBaseRepo(authUrl);
      }
    } else {
      await this.cloneBaseRepo(authUrl);
    }
  }

  private async cloneBaseRepo(authUrl: string): Promise<void> {
    console.log('[Git] Cloning base repository (this only happens once)...');
    console.log('[Git] This may take a while for large repos with submodules...');

    const git = simpleGit({ progress: this.logProgress.bind(this) });

    // Clone with submodules
    await git.clone(authUrl, this.baseRepoPath, [
      '--recurse-submodules',
      '--progress',
    ]);

    console.log('[Git] Base repo cloned');

    // Checkout the base branch
    const repoGit = simpleGit(this.baseRepoPath);
    console.log(`[Git] Checking out ${this.baseBranch}...`);
    await repoGit.checkout(this.baseBranch);
    await repoGit.submoduleUpdate(['--init', '--recursive']);

    console.log('[Git] Base repository ready');
  }

  /**
   * Update the base repo to latest version
   */
  async updateBaseRepo(): Promise<void> {
    const git = simpleGit(this.baseRepoPath);

    console.log(`[Git] Fetching latest changes from origin...`);
    await git.fetch(['origin', '--prune']);

    // Update the base branch reference
    console.log(`[Git] Updating ${this.baseBranch} reference...`);
    await git.checkout(this.baseBranch);
    await git.reset(['--hard', `origin/${this.baseBranch}`]);

    // Update submodules in base repo
    console.log('[Git] Updating submodules in base repo...');
    await git.submoduleUpdate(['--init', '--recursive']);

    console.log('[Git] Base repo updated to latest');
  }

  /**
   * Create a worktree for a specific request - this is very fast!
   */
  async createWorktree(workspace: Workspace, featureBranchName: string): Promise<string> {
    const worktreePath = path.join(workspace.path, 'repo');
    const git = simpleGit(this.baseRepoPath);

    // First, update the base repo to get latest changes
    await this.updateBaseRepo();

    console.log(`[Git] Creating worktree at: ${worktreePath}`);
    console.log(`[Git] Feature branch: ${featureBranchName}`);

    // Create worktree with a new branch based on the base branch
    // git worktree add <path> -b <new-branch> <start-point>
    await git.raw([
      'worktree',
      'add',
      worktreePath,
      '-b',
      featureBranchName,
      `origin/${this.baseBranch}`,
    ]);

    console.log('[Git] Worktree created');

    // Initialize submodules in the worktree
    console.log('[Git] Initializing submodules in worktree...');
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.submoduleUpdate(['--init', '--recursive']);

    console.log('[Git] Worktree ready with submodules');
    return worktreePath;
  }

  /**
   * Clean up a worktree when done
   */
  async removeWorktree(workspace: Workspace): Promise<void> {
    const worktreePath = path.join(workspace.path, 'repo');

    try {
      const git = simpleGit(this.baseRepoPath);
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      console.log(`[Git] Worktree removed: ${worktreePath}`);
    } catch (error) {
      console.error(`[Git] Error removing worktree:`, error);
    }
  }

  /**
   * Prune stale worktrees (e.g., after crashes)
   */
  async pruneWorktrees(): Promise<void> {
    try {
      const git = simpleGit(this.baseRepoPath);
      await git.raw(['worktree', 'prune']);
      console.log('[Git] Stale worktrees pruned');
    } catch (error) {
      // Ignore if base repo doesn't exist yet
    }
  }

  async createBranch(repoPath: string, branchName: string): Promise<void> {
    // With worktree approach, the branch is already created
    // This method is kept for compatibility but does nothing
    console.log(`[Git] Branch ${branchName} already created with worktree`);
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

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private logProgress(event: { method: string; stage: string; progress: number }): void {
    if (event.progress) {
      process.stdout.write(`\r[Git] ${event.method} ${event.stage}: ${event.progress}%   `);
      if (event.progress === 100) {
        console.log('');
      }
    }
  }
}
