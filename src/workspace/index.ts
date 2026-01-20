import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface Workspace {
  id: string;
  path: string;
  requestId: string;
  createdAt: Date;
}

export class WorkspaceManager {
  private workspacesDir: string;

  constructor(workspacesDir: string) {
    this.workspacesDir = workspacesDir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.workspacesDir, { recursive: true });
    console.log(`[Workspace] Workspaces directory ready: ${this.workspacesDir}`);
  }

  async create(requestId: string): Promise<Workspace> {
    const id = uuidv4();
    const workspacePath = path.join(this.workspacesDir, `${requestId}-${id}`);

    await fs.mkdir(workspacePath, { recursive: true });

    const workspace: Workspace = {
      id,
      path: workspacePath,
      requestId,
      createdAt: new Date(),
    };

    console.log(`[Workspace] Created workspace: ${workspacePath}`);
    return workspace;
  }

  async cleanup(workspace: Workspace): Promise<void> {
    try {
      await fs.rm(workspace.path, { recursive: true, force: true });
      console.log(`[Workspace] Cleaned up workspace: ${workspace.path}`);
    } catch (error) {
      console.error(`[Workspace] Failed to cleanup workspace: ${workspace.path}`, error);
    }
  }

  async cleanupAll(): Promise<void> {
    try {
      const entries = await fs.readdir(this.workspacesDir);
      for (const entry of entries) {
        const entryPath = path.join(this.workspacesDir, entry);
        await fs.rm(entryPath, { recursive: true, force: true });
      }
      console.log('[Workspace] Cleaned up all workspaces');
    } catch (error) {
      console.error('[Workspace] Failed to cleanup all workspaces', error);
    }
  }
}
