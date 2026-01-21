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

/**
 * Simple async mutex for serializing access to shared resources
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class GitManager implements GitOperations {
  private gitlabToken: string;
  private repoUrl: string;
  private baseRepoPath: string;
  private baseBranch: string;
  private baseRepoMutex = new AsyncMutex();

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
   * Remove stale lock files if they exist (cleanup after crashes)
   */
  private async cleanupLockFiles(): Promise<void> {
    const lockFile = path.join(this.baseRepoPath, '.git', 'index.lock');
    try {
      await fs.unlink(lockFile);
      console.log('[Git] Removed stale index.lock file');
    } catch {
      // File doesn't exist, which is fine
    }
  }

  /**
   * Ensure the base repository exists and is up to date
   * This is called once at startup
   */
  async ensureBaseRepo(): Promise<void> {
    return this.baseRepoMutex.withLock(async () => {
      const authUrl = this.getAuthenticatedUrl(this.repoUrl);

      // Check if base repo exists
      const exists = await this.directoryExists(this.baseRepoPath);

      if (exists) {
        // Cleanup any stale lock files from previous crashes
        await this.cleanupLockFiles();

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
    });
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
   * Update the base repo to latest version (internal, called within mutex)
   */
  private async updateBaseRepoInternal(): Promise<void> {
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
   * Update the base repo to latest version (public, acquires mutex)
   */
  async updateBaseRepo(): Promise<void> {
    return this.baseRepoMutex.withLock(() => this.updateBaseRepoInternal());
  }

  /**
   * Check if a branch exists locally
   */
  private async branchExists(git: SimpleGit, branchName: string): Promise<boolean> {
    try {
      const branches = await git.branchLocal();
      return branches.all.includes(branchName);
    } catch {
      return false;
    }
  }

  /**
   * Find and remove any worktree using a specific branch
   */
  private async removeWorktreeForBranch(git: SimpleGit, branchName: string): Promise<void> {
    try {
      // List all worktrees
      const result = await git.raw(['worktree', 'list', '--porcelain']);
      const lines = result.split('\n');

      let currentWorktree = '';
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentWorktree = line.substring('worktree '.length);
        } else if (line.startsWith('branch refs/heads/') && currentWorktree) {
          const worktreeBranch = line.substring('branch refs/heads/'.length);
          if (worktreeBranch === branchName && currentWorktree !== this.baseRepoPath) {
            console.log(`[Git] Removing worktree that uses branch ${branchName}: ${currentWorktree}`);
            try {
              await git.raw(['worktree', 'remove', currentWorktree, '--force']);
            } catch (err) {
              // If worktree remove fails, try to delete the directory manually
              console.log(`[Git] Worktree remove failed, trying manual cleanup...`);
              try {
                await fs.rm(currentWorktree, { recursive: true, force: true });
                await git.raw(['worktree', 'prune']);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
          currentWorktree = '';
        }
      }
    } catch (error) {
      console.warn(`[Git] Error checking worktrees:`, error);
    }
  }

  /**
   * Delete a local branch if it exists
   */
  private async deleteBranchIfExists(git: SimpleGit, branchName: string): Promise<void> {
    if (await this.branchExists(git, branchName)) {
      // First, remove any worktree using this branch
      await this.removeWorktreeForBranch(git, branchName);

      console.log(`[Git] Deleting existing local branch: ${branchName}`);
      try {
        await git.branch(['-D', branchName]);
      } catch (error) {
        console.warn(`[Git] Could not delete branch ${branchName}:`, error);
      }
    }
  }

  /**
   * Create a worktree for a specific request - this is very fast!
   * Uses mutex to prevent concurrent access to base repo
   */
  async createWorktree(workspace: Workspace, featureBranchName: string): Promise<string> {
    const worktreePath = path.join(workspace.path, 'repo');

    // Acquire lock for base repo operations
    return this.baseRepoMutex.withLock(async () => {
      // Cleanup any stale lock files from previous crashes
      await this.cleanupLockFiles();

      const git = simpleGit(this.baseRepoPath);

      // Update the base repo to get latest changes
      await this.updateBaseRepoInternal();

      // Delete existing local branch if it exists (from a previous failed run)
      await this.deleteBranchIfExists(git, featureBranchName);

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

      // Initialize submodules in the worktree (this can be done outside the lock
      // but keeping it here for simplicity since it's fast)
      console.log('[Git] Initializing submodules in worktree...');
      const worktreeGit = simpleGit(worktreePath);
      await worktreeGit.submoduleUpdate(['--init', '--recursive']);

      console.log('[Git] Worktree ready with submodules');
      return worktreePath;
    });
  }

  /**
   * Clean up a worktree when done
   */
  async removeWorktree(workspace: Workspace): Promise<void> {
    const worktreePath = path.join(workspace.path, 'repo');

    return this.baseRepoMutex.withLock(async () => {
      try {
        const git = simpleGit(this.baseRepoPath);
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
        console.log(`[Git] Worktree removed: ${worktreePath}`);
      } catch (error) {
        console.error(`[Git] Error removing worktree:`, error);
      }
    });
  }

  /**
   * Prune stale worktrees (e.g., after crashes)
   */
  async pruneWorktrees(): Promise<void> {
    try {
      // Cleanup any stale lock files first
      await this.cleanupLockFiles();

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

    // Clean up Windows reserved filenames that can't be added to git
    await this.cleanupWindowsReservedFiles(repoPath);

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

  async hasCommitsToPush(repoPath: string, branchName: string): Promise<boolean> {
    const git = simpleGit(repoPath);
    try {
      // Check if there are commits on the local branch that aren't on the remote
      const result = await git.raw(['rev-list', '--count', `origin/${branchName}..HEAD`]);
      const count = parseInt(result.trim(), 10);
      return count > 0;
    } catch {
      // If origin/branchName doesn't exist, check if there are any local commits
      try {
        const log = await git.log({ maxCount: 1 });
        return log.total > 0;
      } catch {
        return false;
      }
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Remove Windows reserved filenames that can't be added to git
   * These are special device names on Windows: CON, PRN, AUX, NUL, COM1-9, LPT1-9
   */
  private async cleanupWindowsReservedFiles(repoPath: string): Promise<void> {
    const reservedNames = [
      'nul', 'con', 'prn', 'aux',
      'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
      'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
    ];

    for (const name of reservedNames) {
      const filePath = path.join(repoPath, name);
      try {
        await fs.unlink(filePath);
        console.log(`[Git] Removed Windows reserved file: ${name}`);
      } catch {
        // File doesn't exist, which is fine
      }
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
