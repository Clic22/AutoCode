import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface Config {
  discord: {
    botToken: string;
    channelIds: string[];
    approvalEmoji: string;
    approvedUsers: string[];
    privateChannelIds: string[];
  };
  gitlab: {
    url: string;
    token: string;
    repoUrl: string;
    projectId: string;
    mrPollingInterval?: number;
  };
  workspacesDir: string;
  claudeCliPath: string;
  storageType: 'json' | 'supabase';
  supabase?: {
    url: string;
    serviceRoleKey: string;
    machineId?: string;
  };
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

  // Support comma-separated private channel IDs (with ideation phase)
  const privateChannelIdsRaw = process.env.PRIVATE_CHANNEL_IDS || '';
  const privateChannelIds = privateChannelIdsRaw.split(',').map(id => id.trim()).filter(id => id.length > 0);

  // Determine storage type
  const storageType = (process.env.STORAGE_TYPE as 'json' | 'supabase') || 'json';

  // Supabase configuration (optional, required if storageType is 'supabase')
  let supabase: Config['supabase'] = undefined;
  if (storageType === 'supabase') {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORAGE_TYPE=supabase');
    }

    supabase = {
      url: supabaseUrl,
      serviceRoleKey: supabaseServiceRoleKey,
      machineId: process.env.MACHINE_ID || undefined,
    };
  }

  return {
    discord: {
      botToken: getEnvOrThrow('DISCORD_BOT_TOKEN'),
      channelIds,
      approvalEmoji: process.env.APPROVAL_EMOJI || '✅',
      approvedUsers,
      privateChannelIds,
    },
    gitlab: {
      url: process.env.GITLAB_URL || 'http://gitlab.totemmedia.com',
      token: getEnvOrThrow('GITLAB_TOKEN'),
      repoUrl: process.env.GITLAB_REPO_URL || 'http://gitlab.totemmedia.com/Stephane/qtvghd.git',
      projectId: process.env.GITLAB_PROJECT_ID || 'Stephane/qtvghd',
      mrPollingInterval: process.env.GITLAB_MR_POLLING_INTERVAL
        ? parseInt(process.env.GITLAB_MR_POLLING_INTERVAL, 10)
        : undefined,
    },
    workspacesDir: path.resolve(process.env.WORKSPACES_DIR || './workspaces'),
    claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude',
    storageType,
    supabase,
  };
}
