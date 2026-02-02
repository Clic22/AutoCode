/**
 * Migration script to transfer data from autocode-data.json to Supabase
 *
 * Usage:
 *   npx ts-node scripts/migrate-to-supabase.ts
 *
 * Required environment variables:
 *   SUPABASE_URL - Your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Your Supabase service role key
 *
 * Optional:
 *   MACHINE_ID - Override the machine ID (default: hostname-username)
 *   JSON_DATA_PATH - Path to the JSON file (default: ./autocode-data.json)
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

interface WorkspaceInfo {
  messageId: string;
  workspacePath: string;
  branchName: string;
  repoPath: string;
  status: string;
  attempt: number;
  developmentPrompt?: string;
  lastError?: string;
  mrUrl?: string;
  lastFeedbackAt?: number;
  feedbackCount?: number;
  threadId?: string;
  ideationConversation?: string[];
  lastIdeationTimestamp?: number;
  createdAt: number;
  updatedAt: number;
}

interface ProcessedData {
  processedMessageIds: string[];
  lastScanTimestamp: number;
  workspaces: Record<string, WorkspaceInfo>;
  mrUrlIndex: Record<string, string>;
  branchIndex: Record<string, string>;
  processedCommentIds: string[];
}

async function migrate() {
  // Check environment variables
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required');
    process.exit(1);
  }

  // Generate machine ID
  const machineId = process.env.MACHINE_ID || `${os.hostname()}-${os.userInfo().username}`;
  console.log(`Machine ID: ${machineId}`);

  // Read JSON file
  const jsonPath = process.env.JSON_DATA_PATH || path.join(process.cwd(), 'autocode-data.json');
  console.log(`Reading data from: ${jsonPath}`);

  let data: ProcessedData;
  try {
    const content = await fs.readFile(jsonPath, 'utf-8');
    data = JSON.parse(content);
  } catch (error) {
    console.error(`Error reading JSON file: ${error}`);
    process.exit(1);
  }

  console.log(`Found ${Object.keys(data.workspaces).length} workspaces`);
  console.log(`Found ${data.processedMessageIds.length} processed messages`);
  console.log(`Found ${data.processedCommentIds.length} processed comments`);

  // Connect to Supabase
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  console.log('Connected to Supabase');

  // Migrate workspaces
  console.log('\n--- Migrating workspaces ---');
  for (const [messageId, workspace] of Object.entries(data.workspaces)) {
    console.log(`  Migrating workspace: ${messageId} (${workspace.branchName})`);

    // Insert workspace
    const { error: workspaceError } = await supabase
      .from('workspaces')
      .upsert({
        message_id: workspace.messageId,
        branch_name: workspace.branchName,
        status: workspace.status,
        attempt: workspace.attempt,
        development_prompt: workspace.developmentPrompt || null,
        last_error: workspace.lastError || null,
        mr_url: workspace.mrUrl || null,
        last_feedback_at: workspace.lastFeedbackAt || null,
        feedback_count: workspace.feedbackCount || null,
        thread_id: workspace.threadId || null,
        ideation_conversation: workspace.ideationConversation || [],
        last_ideation_timestamp: workspace.lastIdeationTimestamp || null,
        created_at: workspace.createdAt,
        updated_at: workspace.updatedAt,
      });

    if (workspaceError) {
      console.error(`    Error inserting workspace: ${workspaceError.message}`);
      continue;
    }

    // Insert local paths if they exist
    if (workspace.workspacePath || workspace.repoPath) {
      const { error: localPathError } = await supabase
        .from('workspace_local_paths')
        .upsert({
          message_id: workspace.messageId,
          machine_id: machineId,
          workspace_path: workspace.workspacePath || '',
          repo_path: workspace.repoPath || '',
          created_at: workspace.createdAt,
          updated_at: workspace.updatedAt,
        });

      if (localPathError) {
        console.error(`    Error inserting local path: ${localPathError.message}`);
      }
    }

    console.log(`    Done`);
  }

  // Migrate processed messages
  console.log('\n--- Migrating processed messages ---');
  if (data.processedMessageIds.length > 0) {
    const processedMessages = data.processedMessageIds.map(id => ({
      message_id: id,
      processed_at: Date.now(),
    }));

    // Insert in batches of 100
    for (let i = 0; i < processedMessages.length; i += 100) {
      const batch = processedMessages.slice(i, i + 100);
      const { error } = await supabase
        .from('processed_messages')
        .upsert(batch);

      if (error) {
        console.error(`  Error inserting processed messages batch: ${error.message}`);
      } else {
        console.log(`  Inserted batch ${Math.floor(i / 100) + 1}`);
      }
    }
  }

  // Migrate processed comments
  console.log('\n--- Migrating processed comments ---');
  if (data.processedCommentIds.length > 0) {
    const processedComments = data.processedCommentIds.map(id => ({
      comment_id: id,
      processed_at: Date.now(),
    }));

    // Insert in batches of 100
    for (let i = 0; i < processedComments.length; i += 100) {
      const batch = processedComments.slice(i, i + 100);
      const { error } = await supabase
        .from('processed_comments')
        .upsert(batch);

      if (error) {
        console.error(`  Error inserting processed comments batch: ${error.message}`);
      } else {
        console.log(`  Inserted batch ${Math.floor(i / 100) + 1}`);
      }
    }
  }

  // Migrate app state
  console.log('\n--- Migrating app state ---');
  const { error: appStateError } = await supabase
    .from('app_state')
    .upsert({
      machine_id: machineId,
      last_scan_timestamp: data.lastScanTimestamp,
      updated_at: Date.now(),
    });

  if (appStateError) {
    console.error(`  Error inserting app state: ${appStateError.message}`);
  } else {
    console.log(`  Done`);
  }

  console.log('\n=== Migration complete ===');
  console.log(`
Next steps:
1. Update your .env file with:
   STORAGE_TYPE=supabase
   SUPABASE_URL=${supabaseUrl}
   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>

2. Restart the application

3. (Optional) Backup and remove the old autocode-data.json file
`);
}

migrate().catch(console.error);
