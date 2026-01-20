import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface Config {
  discord: {
    botToken: string;
    channelId: string;
    approvalEmoji: string;
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
  return {
    discord: {
      botToken: getEnvOrThrow('DISCORD_BOT_TOKEN'),
      channelId: getEnvOrThrow('DISCORD_CHANNEL_ID'),
      approvalEmoji: process.env.APPROVAL_EMOJI || '✅',
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
