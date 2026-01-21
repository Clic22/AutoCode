import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface Config {
  discord: {
    botToken: string;
    channelIds: string[];
    approvalEmoji: string;
    approvedUsers: string[];
  };
  gitlab: {
    url: string;
    token: string;
    repoUrl: string;
    projectId: string;
  };
  workspacesDir: string;
  claudeCliPath: string;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(): Config {
  // Support comma-separated channel IDs
  const channelIdsRaw = getEnvOrThrow('DISCORD_CHANNEL_ID');
  const channelIds = channelIdsRaw.split(',').map(id => id.trim()).filter(id => id.length > 0);

  // Support comma-separated approved users
  const approvedUsersRaw = process.env.APPROVED_USERS || '';
  const approvedUsers = approvedUsersRaw.split(',').map(u => u.trim()).filter(u => u.length > 0);

  return {
    discord: {
      botToken: getEnvOrThrow('DISCORD_BOT_TOKEN'),
      channelIds,
      approvalEmoji: process.env.APPROVAL_EMOJI || '✅',
      approvedUsers,
    },
    gitlab: {
      url: process.env.GITLAB_URL || 'http://gitlab.totemmedia.com',
      token: getEnvOrThrow('GITLAB_TOKEN'),
      repoUrl: process.env.GITLAB_REPO_URL || 'http://gitlab.totemmedia.com/Stephane/qtvghd.git',
      projectId: process.env.GITLAB_PROJECT_ID || 'Stephane/qtvghd',
    },
    workspacesDir: path.resolve(process.env.WORKSPACES_DIR || './workspaces'),
    claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude',
  };
}
