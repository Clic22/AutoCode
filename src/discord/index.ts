import {
  Client,
  GatewayIntentBits,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  TextChannel,
  ForumChannel,
  ThreadChannel,
  Partials,
  Collection,
  ChannelType,
} from 'discord.js';
import { IStorage } from '../storage';

export interface CodeRequest {
  id: string;
  messageId: string;
  channelId: string;
  content: string;
  author: string;
  approvedBy: string;
  timestamp: Date;
  threadMessages?: string[];
}

export interface DiscordBotEvents {
  onRequestApproved: (request: CodeRequest) => Promise<void>;
  onIdeationStart?: (messageId: string, channelId: string, threadId: string, content: string, author: string, existingMessages?: string[]) => Promise<void>;
  onIdeationResponse?: (messageId: string, threadId: string, response: string) => Promise<void>;
  onPublicChannelApproval?: (
    sourceMessageId: string,
    sourceChannelId: string,
    content: string,
    author: string,
    threadMessages: string[],
    approvedBy: string
  ) => Promise<void>;
  onDiscordFeedback?: (messageId: string, threadId: string, feedback: string, author: string) => Promise<void>;
  onDiscordValidation?: (messageId: string) => Promise<void>;
  onBaseBranchResponse?: (messageId: string, threadId: string, baseBranch: string, author: string) => Promise<void>;
  onIdeationApproved?: (messageId: string, threadId: string) => Promise<void>;
}

export class DiscordBot {
  private client: Client;
  private channelIds: string[];
  private approvalEmoji: string;
  private approvedUsers: string[];
  private privateChannelIds: string[];
  private events: DiscordBotEvents;
  private storage: IStorage;
  private sessionProcessed: Set<string> = new Set();

  constructor(channelIds: string[], approvalEmoji: string, approvedUsers: string[], privateChannelIds: string[], events: DiscordBotEvents, storage: IStorage) {
    this.channelIds = channelIds;
    this.approvalEmoji = approvalEmoji;
    this.approvedUsers = approvedUsers;
    this.privateChannelIds = privateChannelIds;
    this.events = events;
    this.storage = storage;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Reaction],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      console.log(`[Discord] Bot logged in as ${this.client.user?.tag}`);
      console.log(`[Discord] Monitoring channels: ${this.channelIds.join(', ')}`);
      console.log(`[Discord] Approval emoji: ${this.approvalEmoji}`);
      if (this.privateChannelIds.length > 0) {
        console.log(`[Discord] Private channels (with ideation): ${this.privateChannelIds.join(', ')}`);
      }
    });

    this.client.on('messageReactionAdd', async (reaction, user) => {
      await this.handleReaction(reaction, user);
    });

    this.client.on('threadCreate', async (thread) => {
      await this.handleThreadCreate(thread);
    });

    this.client.on('messageCreate', async (message) => {
      await this.handleNewMessage(message);
    });

    this.client.on('error', (error) => {
      console.error('[Discord] Client error:', error);
    });
  }

  private isApprovalEmoji(emoji: { name: string | null; id: string | null; toString: () => string }): boolean {
    const emojiIdentifier = emoji.name || emoji.id;
    return emojiIdentifier === this.approvalEmoji || emoji.toString() === this.approvalEmoji;
  }

  private isApprovedUser(username: string): boolean {
    // If no approved users configured, allow all
    if (this.approvedUsers.length === 0) {
      return true;
    }
    return this.approvedUsers.includes(username);
  }

  private isPrivateChannel(channelId: string): boolean {
    return this.privateChannelIds.includes(channelId);
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    try {
      if (reaction.partial) {
        reaction = await reaction.fetch();
      }

      const message = reaction.message;
      if (message.partial) {
        await message.fetch();
      }

      // Check if the message is in one of the monitored channels (public or private) or in a thread of one
      const channel = message.channel;
      let isInPublicChannel = this.channelIds.includes(message.channelId);
      let isInPrivateChannel = this.privateChannelIds.includes(message.channelId);
      let parentChannelId: string | null = null;

      // If it's a thread, check if the parent is one of our monitored channels (public or private)
      if (!isInPublicChannel && !isInPrivateChannel && channel.isThread()) {
        parentChannelId = channel.parentId || '';
        isInPublicChannel = this.channelIds.includes(parentChannelId);
        isInPrivateChannel = this.privateChannelIds.includes(parentChannelId);
      }

      if (!isInPublicChannel && !isInPrivateChannel) {
        return;
      }

      console.log(`[Discord] Reaction detected on message ${message.id} in ${isInPublicChannel ? 'public' : 'private'} channel`);

      if (!this.isApprovalEmoji(reaction.emoji)) {
        console.log(`[Discord] Not approval emoji (expected: ${this.approvalEmoji}, got: ${reaction.emoji.name || reaction.emoji.toString()}), ignoring`);
        return;
      }

      // Ignore bot reactions
      if (user.bot) {
        console.log(`[Discord] Bot reaction, ignoring`);
        return;
      }

      // Check if user is authorized to approve
      const username = user.username || 'unknown';
      if (!this.isApprovedUser(username)) {
        console.log(`[Discord] User ${username} is not authorized to approve, ignoring`);
        return;
      }

      // Handle PUBLIC channel approval - create thread in private channel for ideation
      // For public channels (text or forum), we start cross-channel ideation
      // Exception: if it's a thread in a text channel that was created by the bot for ideation (private flow)
      if (isInPublicChannel) {
        // Check if already processed via source message index (deduplication)
        const existingWorkspace = this.storage.getWorkspaceBySourceMessage(message.id);
        if (existingWorkspace) {
          console.log(`[Discord] Message ${message.id} already has a workspace (via source index), skipping`);
          return;
        }

        if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
          console.log(`[Discord] Message ${message.id} already processed, skipping`);
          return;
        }

        this.sessionProcessed.add(message.id);
        console.log(`[Discord] ✅ Public channel approval detected on message ${message.id} by ${username}`);

        // Collect thread messages if any (for forum posts or text channel threads)
        let threadMessages: string[] = [];
        if (channel.isThread()) {
          threadMessages = await this.collectForumThreadMessages(channel as ThreadChannel);
        } else {
          threadMessages = await this.collectThreadMessages(message as Message);
        }

        // Trigger public channel approval event
        if (this.events.onPublicChannelApproval) {
          await this.events.onPublicChannelApproval(
            message.id,
            parentChannelId || message.channelId, // Use parent for forums, channelId for text
            message.content || '',
            message.author?.username || 'unknown',
            threadMessages,
            username
          );
        }
        return;
      }

      // Handle PRIVATE channel approval
      // First, check if this is a thread with an MR workspace (for validation approval)
      if (channel.isThread()) {
        const thread = channel as ThreadChannel;
        let workspace = this.storage.getWorkspaceByThread(thread.id);

        // If not found by thread, try by starter message
        if (!workspace) {
          const starterMessage = await thread.fetchStarterMessage();
          if (starterMessage) {
            workspace = this.storage.getWorkspace(starterMessage.id);
          }
        }

        // If workspace is in MR phase, this is a validation approval
        if (workspace && (workspace.status === 'mr_created' || workspace.status === 'awaiting_validation')) {
          console.log(`[Discord] ✅ Validation emoji detected for workspace ${workspace.messageId} by ${username}`);
          if (this.events.onDiscordValidation) {
            await this.events.onDiscordValidation(workspace.messageId);
          }
          return;
        }
      }

      // Standard flow: ideation complete -> ask for base branch -> implementation
      if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
        console.log(`[Discord] Message ${message.id} already processed, skipping`);
        return;
      }

      // Check if this is a workspace in ideation_complete status
      const workspace = this.storage.getWorkspace(message.id);
      if (workspace && workspace.status === 'ideation_complete' && workspace.threadId && !workspace.baseBranch) {
        console.log(`[Discord] ✅ Ideation approval detected on message ${message.id} by ${username}`);
        // Trigger ideation approved event to ask for base branch
        if (this.events.onIdeationApproved) {
          await this.events.onIdeationApproved(message.id, workspace.threadId);
        }
        return;
      }

      this.sessionProcessed.add(message.id);

      console.log(`[Discord] ✅ Approval detected on message ${message.id} by ${username}`);

      const request = await this.buildCodeRequest(message as Message, user.username || 'unknown');
      await this.events.onRequestApproved(request);
    } catch (error) {
      console.error('[Discord] Error handling reaction:', error);
    }
  }

  private async handleThreadCreate(thread: ThreadChannel): Promise<void> {
    try {
      const parentChannelId = thread.parentId;
      if (!parentChannelId || !this.isPrivateChannel(parentChannelId)) {
        return;
      }

      console.log(`[Discord] New thread created in private channel: ${thread.name}`);

      // Fetch the starter message
      const starterMessage = await thread.fetchStarterMessage();
      if (!starterMessage) {
        console.log(`[Discord] Could not fetch starter message for thread ${thread.id}`);
        return;
      }

      // Ignore bot threads
      if (starterMessage.author.bot) {
        return;
      }

      // Check if user is authorized
      const username = starterMessage.author.username || 'unknown';
      if (!this.isApprovedUser(username)) {
        console.log(`[Discord] User ${username} is not authorized for private channel, ignoring thread`);
        return;
      }

      // Check if already processed or in ideation
      if (this.storage.isProcessed(starterMessage.id) || this.sessionProcessed.has(starterMessage.id)) {
        console.log(`[Discord] Thread starter message ${starterMessage.id} already processed`);
        return;
      }

      // Check if this message already has a workspace
      const existingWorkspace = this.storage.getWorkspace(starterMessage.id);
      if (existingWorkspace) {
        console.log(`[Discord] Thread ${thread.id} already has workspace in status: ${existingWorkspace.status}`);
        return;
      }

      console.log(`[Discord] Starting ideation for thread: ${thread.name}`);
      console.log(`[Discord] Starter message from: ${username}`);

      // Trigger ideation start event
      if (this.events.onIdeationStart) {
        await this.events.onIdeationStart(
          starterMessage.id,
          parentChannelId,
          thread.id,
          starterMessage.content,
          username
        );
      }
    } catch (error) {
      console.error('[Discord] Error handling thread create:', error);
    }
  }

  private async handleNewMessage(message: Message): Promise<void> {
    try {
      // Ignore bot messages
      if (message.author.bot) {
        return;
      }

      // Only handle messages in threads
      const isThread = message.channel.isThread();
      if (!isThread) {
        return;
      }

      const thread = message.channel as ThreadChannel;
      const parentChannelId = thread.parentId;

      // Check if this thread is in a private channel
      if (!parentChannelId || !this.isPrivateChannel(parentChannelId)) {
        return;
      }

      // Check if user is authorized
      const username = message.author.username || 'unknown';
      if (!this.isApprovedUser(username)) {
        console.log(`[Discord] User ${username} is not authorized for private channel, ignoring message`);
        return;
      }

      // Try to find workspace by thread index first (faster)
      let workspace = this.storage.getWorkspaceByThread(thread.id);

      // If not found, fall back to fetching starter message (existing behavior)
      if (!workspace) {
        const starterMessage = await thread.fetchStarterMessage();
        if (starterMessage) {
          workspace = this.storage.getWorkspace(starterMessage.id);
        }
      }

      if (!workspace) {
        console.log(`[Discord] No workspace found for thread ${thread.id}`);
        return;
      }

      // Route based on workspace status
      if (workspace.status.startsWith('ideation_')) {
        // Ideation phase: handle as ideation response
        await this.handleIdeationResponse(message, username);
      } else if (workspace.status === 'awaiting_base_branch') {
        // Base branch selection phase: handle as branch choice
        await this.handleBaseBranchResponse(message, workspace.messageId, thread.id, username);
      } else if (workspace.status === 'mr_created' || workspace.status === 'awaiting_validation') {
        // MR phase: handle as MR feedback
        await this.handleMRFeedback(message, workspace.messageId, thread.id, username);
      }
    } catch (error) {
      console.error('[Discord] Error handling new message:', error);
    }
  }

  /**
   * Handle feedback message in a thread with an active MR
   */
  private async handleMRFeedback(message: Message, messageId: string, threadId: string, author: string): Promise<void> {
    const content = message.content.trim();

    // Check for approval keywords
    const approvalKeywords = ['approve', 'approved', 'validated', 'done', 'lgtm', 'ok', '👍', '✅'];
    const contentLower = content.toLowerCase();

    const isApproval = approvalKeywords.some(keyword => {
      // Match whole word only for short keywords to avoid false positives
      if (keyword.length <= 4) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        return regex.test(contentLower);
      }
      return contentLower.includes(keyword);
    });

    if (isApproval) {
      console.log(`[Discord] Validation detected from ${author} in thread ${threadId}`);
      if (this.events.onDiscordValidation) {
        await this.events.onDiscordValidation(messageId);
      }
    } else {
      console.log(`[Discord] Feedback received from ${author} in thread ${threadId}`);
      console.log(`[Discord] Feedback: ${content.substring(0, 100)}...`);
      if (this.events.onDiscordFeedback) {
        await this.events.onDiscordFeedback(messageId, threadId, content, author);
      }
    }
  }

  private async handleIdeationResponse(message: Message, username: string): Promise<void> {
    try {
      const thread = message.channel as ThreadChannel;

      // Get the starter message ID to find the workspace
      const starterMessage = await thread.fetchStarterMessage();
      if (!starterMessage) {
        console.log(`[Discord] Could not fetch starter message for thread ${thread.id}`);
        return;
      }

      const messageId = starterMessage.id;
      const workspace = this.storage.getWorkspace(messageId);

      if (!workspace) {
        console.log(`[Discord] No workspace found for thread ${thread.id}`);
        return;
      }

      // Check if workspace is in ideation phase
      if (!workspace.status.startsWith('ideation_')) {
        console.log(`[Discord] Workspace ${messageId} not in ideation phase (status: ${workspace.status})`);
        return;
      }

      console.log(`[Discord] User response in ideation thread: ${thread.id}`);
      console.log(`[Discord] Response: ${message.content.substring(0, 100)}...`);

      // Trigger ideation response event
      if (this.events.onIdeationResponse) {
        await this.events.onIdeationResponse(messageId, thread.id, message.content);
      }
    } catch (error) {
      console.error('[Discord] Error handling ideation response:', error);
    }
  }

  /**
   * Handle base branch selection response
   */
  private async handleBaseBranchResponse(message: Message, messageId: string, threadId: string, author: string): Promise<void> {
    const content = message.content.trim().toLowerCase();

    // Parse the branch choice
    // Supported formats:
    // - "1", "2", "3", "4" (option numbers)
    // - "preview", "stable", "beta" (branch names)
    // - "release/preview", "release/stable", "release/beta" (full branch names)
    // - Any other text is treated as a custom branch name

    let baseBranch: string | null = null;

    // Check for numbered options
    if (content === '1' || content.includes('preview')) {
      baseBranch = 'release/preview';
    } else if (content === '2' || content.includes('stable')) {
      baseBranch = 'release/stable';
    } else if (content === '3' || content.includes('beta')) {
      baseBranch = 'release/beta';
    } else if (content === '4' || content.startsWith('autre') || content.startsWith('other') || content.startsWith('custom')) {
      // User wants to specify a custom branch
      // Try to extract branch name from the message
      // Format: "4: my-branch" or "autre: my-branch" or just a branch name
      const branchMatch = message.content.match(/(?:4|autre|other|custom)\s*[:=]?\s*(.+)/i);
      if (branchMatch) {
        baseBranch = branchMatch[1].trim();
      }
    } else {
      // Treat as custom branch name directly
      baseBranch = message.content.trim();
    }

    if (!baseBranch) {
      console.log(`[Discord] Could not parse base branch from: ${message.content}`);
      return;
    }

    console.log(`[Discord] Base branch selected by ${author}: ${baseBranch}`);

    // Trigger base branch response event
    if (this.events.onBaseBranchResponse) {
      await this.events.onBaseBranchResponse(messageId, threadId, baseBranch, author);
    }
  }

  private async getOrCreateThread(message: Message): Promise<ThreadChannel> {
    // Check if message already has a thread
    if (message.hasThread && message.thread) {
      console.log(`[Discord] Using existing thread: ${message.thread.id}`);
      return message.thread;
    }

    // Create a new thread
    const threadName = `💭 ${message.content.substring(0, 80)}${message.content.length > 80 ? '...' : ''}`;
    console.log(`[Discord] Creating thread: ${threadName}`);

    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // 24 hours
    });

    console.log(`[Discord] Thread created: ${thread.id}`);
    return thread;
  }

  /**
   * Collect messages from a thread attached to a message
   */
  private async collectThreadMessages(message: Message): Promise<string[]> {
    let threadMessages: string[] = [];

    if (message.hasThread && message.thread) {
      try {
        const thread = message.thread;
        const messages = await thread.messages.fetch({ limit: 100 });
        threadMessages = messages
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => `${m.author.username}: ${m.content}`)
          .filter((content) => content.trim());
        console.log(`[Discord] Collected ${threadMessages.length} thread messages`);
      } catch (error) {
        console.error('[Discord] Error fetching thread messages:', error);
      }
    }

    return threadMessages;
  }

  /**
   * Create a thread in the first private channel for cross-channel ideation
   * threadMessages should contain ALL messages from the source thread (including the first one)
   */
  async createThreadInPrivateChannel(
    sourceContent: string,
    sourceAuthor: string,
    sourceChannelId: string,
    threadMessages: string[],
    customTitle?: string
  ): Promise<{ threadId: string; starterMessageId: string }> {
    if (this.privateChannelIds.length === 0) {
      throw new Error('No private channels configured');
    }

    const privateChannelId = this.privateChannelIds[0];
    console.log(`[Discord] Creating thread in private channel ${privateChannelId}`);

    const channel = await this.client.channels.fetch(privateChannelId);
    if (!channel) {
      throw new Error(`Private channel ${privateChannelId} not found`);
    }

    // Build the starter message
    let starterContent = `📥 **Imported from public channel**\n\n`;

    // If we have thread messages, the first one is the original request
    // Otherwise fall back to just the source content
    if (threadMessages.length > 0) {
      starterContent += `📝 **Original request:**\n\n${threadMessages[0]}`;
    } else {
      starterContent += `📝 **Original request by ${sourceAuthor}:**\n${sourceContent}`;
    }

    // Truncate starter if too long
    if (starterContent.length > 1900) {
      starterContent = starterContent.substring(0, 1897) + '...';
    }

    // Create thread name from custom title or fallback to truncated source content
    const threadName = customTitle
      ? `💭 ${customTitle}`
      : `💭 ${sourceContent.substring(0, 80)}${sourceContent.length > 80 ? '...' : ''}`;

    let threadId: string;
    let starterMessageId: string;
    let thread: ThreadChannel;

    // Handle Forum Channel (type 15)
    if (channel.type === ChannelType.GuildForum) {
      const forum = channel as ForumChannel;
      const createdThread = await forum.threads.create({
        name: threadName,
        message: {
          content: starterContent,
        },
        autoArchiveDuration: 1440, // 24 hours
      });
      thread = createdThread;
      threadId = createdThread.id;

      // Fetch starter message
      const starterMessage = await createdThread.fetchStarterMessage();
      starterMessageId = starterMessage?.id || createdThread.id;

      console.log(`[Discord] Created forum thread: ${threadId}`);
    }
    // Handle Text Channel (type 0)
    else if (channel instanceof TextChannel) {
      // Post a message first, then create a thread from it
      const message = await channel.send(starterContent);
      const createdThread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
      });
      thread = createdThread;
      threadId = createdThread.id;
      starterMessageId = message.id;

      console.log(`[Discord] Created text channel thread: ${threadId}`);
    } else {
      throw new Error(`Unsupported channel type for private channel ${privateChannelId}`);
    }

    // Post the discussion/responses (skip first message, it's already in the starter)
    const responses = threadMessages.slice(1);
    if (responses.length > 0) {
      // Start with a header for the responses
      let currentMessage = `💬 **Discussion / Additional context (${responses.length} message(s)):**\n\n`;

      for (const msg of responses) {
        const separator = '\n\n---\n\n';
        const potentialMessage = currentMessage + separator + msg;

        if (potentialMessage.length > 1900) {
          // Post current message and start a new one
          if (currentMessage) {
            await thread.send(currentMessage);
          }
          // If single message is too long, split it
          if (msg.length > 1900) {
            const chunks = this.splitMessage(msg, 1900);
            for (const chunk of chunks) {
              await thread.send(chunk);
            }
            currentMessage = '';
          } else {
            currentMessage = msg;
          }
        } else {
          currentMessage = potentialMessage;
        }
      }
      // Post remaining content
      if (currentMessage) {
        await thread.send(currentMessage);
      }
    }

    return { threadId, starterMessageId };
  }

  /**
   * Split a long message into chunks
   */
  private splitMessage(message: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = message;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      // Try to split at a newline
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good newline, split at space
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good space, hard split
        splitIndex = maxLength;
      }
      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }
    return chunks;
  }

  async postToThread(threadId: string, content: string): Promise<void> {
    try {
      const thread = await this.client.channels.fetch(threadId) as ThreadChannel;
      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      await thread.send(content);
      console.log(`[Discord] Posted message to thread ${threadId}`);
    } catch (error) {
      console.error(`[Discord] Error posting to thread ${threadId}:`, error);
      throw error;
    }
  }

  private async buildCodeRequest(message: Message, approvedBy: string): Promise<CodeRequest> {
    let threadMessages: string[] = [];

    // Case 1: Message has a thread attached (text channel with thread)
    if (message.hasThread && message.thread) {
      try {
        const thread = message.thread;
        const messages = await thread.messages.fetch({ limit: 100 });
        threadMessages = messages
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => `${m.author.username}: ${m.content}`)
          .filter((content) => content.trim());
        console.log(`[Discord] Collected ${threadMessages.length} thread messages (attached thread)`);
      } catch (error) {
        console.error('[Discord] Error fetching thread messages:', error);
      }
    }
    // Case 2: Message IS in a thread (forum channel)
    else if (message.channel.isThread()) {
      try {
        const thread = message.channel as ThreadChannel;
        const messages = await thread.messages.fetch({ limit: 100 });
        threadMessages = messages
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => `${m.author.username}: ${m.content}`)
          .filter((content) => content.trim());
        console.log(`[Discord] Collected ${threadMessages.length} thread messages (forum thread)`);
      } catch (error) {
        console.error('[Discord] Error fetching thread messages:', error);
      }
    }

    return {
      id: message.id,
      messageId: message.id,
      channelId: message.channelId,
      content: message.content || '',
      author: message.author?.username || 'unknown',
      approvedBy,
      timestamp: new Date(message.createdTimestamp),
      threadMessages,
    };
  }

  async connect(token: string): Promise<void> {
    console.log('[Discord] Connecting...');
    await this.client.login(token);

    // Wait for client to be ready
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) {
        resolve();
      } else {
        this.client.once('ready', () => resolve());
      }
    });
  }

  async scanChannelForApprovedMessages(): Promise<CodeRequest[]> {
    console.log('[Discord] Scanning channels for approved messages...');
    console.log(`[Discord] Public Channel IDs: ${this.channelIds.join(', ')}`);
    if (this.privateChannelIds.length > 0) {
      console.log(`[Discord] Private Channel IDs: ${this.privateChannelIds.join(', ')}`);
    }

    const allApprovedRequests: CodeRequest[] = [];

    // Scan PUBLIC channels - these now trigger cross-channel ideation
    for (const channelId of this.channelIds) {
      try {
        console.log(`[Discord] Scanning channel: ${channelId} (public, cross-channel ideation)`);
        const channel = await this.client.channels.fetch(channelId);

        if (!channel) {
          console.error(`[Discord] Channel ${channelId} not found. Check DISCORD_CHANNEL_ID in .env`);
          continue;
        }

        console.log(`[Discord] Channel ${channelId} type: ${channel.type}`);

        // Handle Forum Channel (type 15)
        if (channel.type === ChannelType.GuildForum) {
          await this.scanPublicForumForApproval(channel as ForumChannel);
        }
        // Handle Text Channel (type 0)
        else if (channel instanceof TextChannel) {
          await this.scanPublicTextChannelForApproval(channel);
        } else {
          console.error(`[Discord] Unsupported channel type for ${channelId}:`, channel.type);
        }
      } catch (error) {
        console.error(`[Discord] Error scanning channel ${channelId}:`, error);
      }
    }

    // Scan PRIVATE channels (with ideation phase)
    // Check for threads that need ideation started or completed requests
    for (const channelId of this.privateChannelIds) {
      try {
        console.log(`[Discord] Scanning channel: ${channelId} (private, ideation-based)`);
        const channel = await this.client.channels.fetch(channelId);

        if (!channel) {
          console.error(`[Discord] Channel ${channelId} not found. Check PRIVATE_CHANNEL_IDS in .env`);
          continue;
        }

        console.log(`[Discord] Channel ${channelId} type: ${channel.type}`);

        // Handle Forum Channel (type 15)
        if (channel.type === ChannelType.GuildForum) {
          // Scan for unprocessed threads to start ideation
          await this.scanPrivateForumForIdeation(channel as ForumChannel);
          // Scan for threads with approval emoji (ideation completed)
          const requests = await this.scanForumChannel(channel as ForumChannel);
          allApprovedRequests.push(...requests);
        }
        // Handle Text Channel (type 0)
        else if (channel instanceof TextChannel) {
          const requests = await this.scanTextChannel(channel);
          allApprovedRequests.push(...requests);
        } else {
          console.error(`[Discord] Unsupported channel type for ${channelId}:`, channel.type);
        }
      } catch (error) {
        console.error(`[Discord] Error scanning channel ${channelId}:`, error);
      }
    }

    // Sort all requests by timestamp (oldest first)
    allApprovedRequests.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    console.log(`[Discord] Total scan complete. Found ${allApprovedRequests.length} approved requests across all channels.`);
    return allApprovedRequests;
  }

  /**
   * Scan a public forum channel for approved messages that need cross-channel ideation
   */
  private async scanPublicForumForApproval(forum: ForumChannel): Promise<void> {
    console.log(`[Discord] Scanning public forum for approved threads...`);

    const allThreads: ThreadChannel[] = [];

    // Fetch active threads
    const activeThreads = await forum.threads.fetchActive();
    allThreads.push(...Array.from(activeThreads.threads.values()));

    // Fetch archived threads
    const archivedThreads = await forum.threads.fetchArchived({ limit: 100 });
    allThreads.push(...Array.from(archivedThreads.threads.values()));

    console.log(`[Discord] Found ${allThreads.length} total threads to check in public forum`);

    for (const thread of allThreads) {
      try {
        const starterMessage = await thread.fetchStarterMessage();
        if (!starterMessage) continue;

        const messageId = starterMessage.id;

        // Check deduplication via source message index
        const existingWorkspace = this.storage.getWorkspaceBySourceMessage(messageId);
        if (existingWorkspace) {
          continue;
        }

        // Skip if already processed
        if (this.storage.isProcessed(messageId) || this.sessionProcessed.has(messageId)) {
          continue;
        }

        // Check for approval emoji
        const reactions = starterMessage.reactions.cache;
        for (const reaction of reactions.values()) {
          if (this.isApprovalEmoji(reaction.emoji)) {
            // Get who approved it
            let approvedBy: string | null = null;
            try {
              const users = await reaction.users.fetch();
              for (const reactionUser of users.values()) {
                if (this.isApprovedUser(reactionUser.username)) {
                  approvedBy = reactionUser.username;
                  break;
                }
              }
            } catch (error) {
              console.error('[Discord] Error fetching reaction users:', error);
            }

            if (!approvedBy) continue;

            console.log(`[Discord] Found approved public forum thread: ${thread.name} by ${approvedBy}`);
            this.sessionProcessed.add(messageId);

            // Collect thread messages
            const threadMessages = await this.collectForumThreadMessages(thread);

            // Trigger public channel approval event
            if (this.events.onPublicChannelApproval) {
              await this.events.onPublicChannelApproval(
                messageId,
                forum.id,
                starterMessage.content || '',
                starterMessage.author?.username || 'unknown',
                threadMessages,
                approvedBy
              );
            }
            break;
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as { code: number }).code === 10008) {
          console.log(`[Discord] Starter message for thread ${thread.id} was deleted, skipping`);
          continue;
        }
        console.error(`[Discord] Error processing public forum thread ${thread.id}:`, error);
      }
    }
  }

  /**
   * Scan a public text channel for approved messages that need cross-channel ideation
   */
  private async scanPublicTextChannelForApproval(channel: TextChannel): Promise<void> {
    console.log(`[Discord] Scanning public text channel for approved messages...`);
    let lastMessageId: string | undefined;
    let totalScanned = 0;
    const maxMessages = 500;

    while (totalScanned < maxMessages) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastMessageId) {
        options.before = lastMessageId;
      }

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) {
        break;
      }

      for (const message of messages.values()) {
        // Check deduplication via source message index
        const existingWorkspace = this.storage.getWorkspaceBySourceMessage(message.id);
        if (existingWorkspace) {
          continue;
        }

        // Skip if already processed
        if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
          continue;
        }

        // Check for approval emoji
        const reactions = message.reactions.cache;
        for (const reaction of reactions.values()) {
          if (this.isApprovalEmoji(reaction.emoji)) {
            // Get who approved it
            let approvedBy: string | null = null;
            try {
              const users = await reaction.users.fetch();
              for (const reactionUser of users.values()) {
                if (this.isApprovedUser(reactionUser.username)) {
                  approvedBy = reactionUser.username;
                  break;
                }
              }
            } catch (error) {
              console.error('[Discord] Error fetching reaction users:', error);
            }

            if (!approvedBy) continue;

            console.log(`[Discord] Found approved public message: ${message.id} by ${approvedBy}`);
            this.sessionProcessed.add(message.id);

            // Collect thread messages if any
            const threadMessages = await this.collectThreadMessages(message);

            // Trigger public channel approval event
            if (this.events.onPublicChannelApproval) {
              await this.events.onPublicChannelApproval(
                message.id,
                channel.id,
                message.content || '',
                message.author?.username || 'unknown',
                threadMessages,
                approvedBy
              );
            }
            break;
          }
        }

        lastMessageId = message.id;
      }

      totalScanned += messages.size;
      console.log(`[Discord] Scanned ${totalScanned} messages in public text channel...`);
    }
  }

  /**
   * Collect ALL messages from a forum thread (including starter message)
   * Returns formatted messages with author, timestamp and content
   */
  private async collectForumThreadMessages(thread: ThreadChannel): Promise<string[]> {
    let threadMessages: string[] = [];
    try {
      const messages = await thread.messages.fetch({ limit: 100 });
      threadMessages = messages
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => {
          const date = new Date(m.createdTimestamp).toLocaleString('fr-FR');
          // Include attachments info if any
          const attachments = m.attachments.size > 0
            ? ` [${m.attachments.size} attachment(s)]`
            : '';
          return `**${m.author.username}** (${date})${attachments}:\n${m.content}`;
        })
        .filter((content) => content.trim());
      console.log(`[Discord] Collected ${threadMessages.length} forum thread messages`);
    } catch (error) {
      console.error('[Discord] Error fetching forum thread messages:', error);
    }
    return threadMessages;
  }

  private async scanPrivateForumForIdeation(forum: ForumChannel): Promise<void> {
    console.log(`[Discord] Scanning private forum for threads needing ideation...`);

    const allThreads: ThreadChannel[] = [];

    // Fetch active threads
    const activeThreads = await forum.threads.fetchActive();
    allThreads.push(...Array.from(activeThreads.threads.values()));

    // Fetch archived threads
    const archivedThreads = await forum.threads.fetchArchived({ limit: 100 });
    allThreads.push(...Array.from(archivedThreads.threads.values()));

    console.log(`[Discord] Found ${allThreads.length} total threads to check`);

    for (const thread of allThreads) {
      try {
        const starterMessage = await thread.fetchStarterMessage();
        if (!starterMessage || starterMessage.author.bot) {
          continue;
        }

        const messageId = starterMessage.id;
        const username = starterMessage.author.username || 'unknown';

        // Skip if already processed or has a workspace
        if (this.storage.isProcessed(messageId) || this.sessionProcessed.has(messageId)) {
          continue;
        }

        // Skip if already has a workspace (even in ideation phase)
        const existingWorkspace = this.storage.getWorkspace(messageId);
        if (existingWorkspace) {
          console.log(`[Discord] Thread ${thread.id} already has workspace in status: ${existingWorkspace.status}`);
          continue;
        }

        // Check if user is authorized
        if (!this.isApprovedUser(username)) {
          continue;
        }

        console.log(`[Discord] Found unprocessed thread: ${thread.name}`);
        console.log(`[Discord] Starting ideation for thread ${thread.id}...`);

        // Fetch all existing messages in the thread
        let existingMessages: string[] = [];
        try {
          const messages = await thread.messages.fetch({ limit: 100 });
          existingMessages = messages
            .filter((m) => !m.author.bot) // Exclude bot messages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => `${m.author.username}: ${m.content}`)
            .filter((msg) => msg.trim());

          if (existingMessages.length > 1) {
            console.log(`[Discord] Found ${existingMessages.length} existing messages in thread`);
          }
        } catch (error) {
          console.warn(`[Discord] Could not fetch thread messages:`, error);
        }

        // Trigger ideation start event
        if (this.events.onIdeationStart) {
          await this.events.onIdeationStart(
            messageId,
            forum.id,
            thread.id,
            starterMessage.content,
            username,
            existingMessages.length > 0 ? existingMessages : undefined
          );
        }
      } catch (error) {
        console.error(`[Discord] Error processing thread ${thread.id}:`, error);
      }
    }
  }

  private async scanForumChannel(forum: ForumChannel): Promise<CodeRequest[]> {
    console.log(`[Discord] Scanning forum channel for approved threads...`);
    const approvedRequests: CodeRequest[] = [];

    // Fetch active threads
    const activeThreads = await forum.threads.fetchActive();
    console.log(`[Discord] Found ${activeThreads.threads.size} active threads`);

    // Fetch archived threads
    const archivedThreads = await forum.threads.fetchArchived({ limit: 100 });
    console.log(`[Discord] Found ${archivedThreads.threads.size} archived threads`);

    // Combine all threads
    const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];

    for (const thread of allThreads) {
      // Skip if already processed
      if (this.storage.isProcessed(thread.id) || this.sessionProcessed.has(thread.id)) {
        continue;
      }

      try {
        // Get the starter message (first message in thread)
        const starterMessage = await thread.fetchStarterMessage();
        if (!starterMessage) {
          continue;
        }

        // Check for approval emoji in reactions
        const reactions = starterMessage.reactions.cache;
        for (const reaction of reactions.values()) {
          if (this.isApprovalEmoji(reaction.emoji)) {
            // Get who approved it and check if they're authorized
            let approvedBy: string | null = null;
            try {
              const users = await reaction.users.fetch();
              // Find the first approved user who reacted
              for (const reactionUser of users.values()) {
                if (this.isApprovedUser(reactionUser.username)) {
                  approvedBy = reactionUser.username;
                  break;
                }
              }
            } catch (error) {
              console.error('[Discord] Error fetching reaction users:', error);
            }

            // Skip if no authorized user approved
            if (!approvedBy) {
              continue;
            }

            console.log(`[Discord] Found approved thread: ${thread.name} (${thread.id}) by ${approvedBy}`);
            this.sessionProcessed.add(thread.id);
            const request = await this.buildCodeRequestFromThread(thread, starterMessage, approvedBy);
            approvedRequests.push(request);
            break;
          }
        }
      } catch (error: unknown) {
        // Handle "Unknown Message" error (10008) - starter message was deleted
        if (error instanceof Error && 'code' in error && (error as { code: number }).code === 10008) {
          console.log(`[Discord] Starter message for thread ${thread.id} was deleted, skipping`);
          continue;
        }
        console.error(`[Discord] Error processing thread ${thread.id}:`, error);
      }
    }

    // Sort by timestamp (oldest first)
    approvedRequests.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    console.log(`[Discord] Forum scan complete. Found ${approvedRequests.length} approved requests.`);
    return approvedRequests;
  }

  private async buildCodeRequestFromThread(
    thread: ThreadChannel,
    starterMessage: Message,
    approvedBy: string
  ): Promise<CodeRequest> {
    // Collect all messages in the thread as context
    let threadMessages: string[] = [];
    try {
      const messages = await thread.messages.fetch({ limit: 100 });
      threadMessages = messages
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => `${m.author.username}: ${m.content}`)
        .filter((content) => content.trim());
    } catch (error) {
      console.error('[Discord] Error fetching thread messages:', error);
    }

    return {
      id: thread.id,
      messageId: starterMessage.id,
      channelId: thread.id,
      content: `**${thread.name}**\n\n${starterMessage.content}`,
      author: starterMessage.author?.username || 'unknown',
      approvedBy,
      timestamp: new Date(thread.createdTimestamp || Date.now()),
      threadMessages,
    };
  }

  private async scanTextChannel(channel: TextChannel): Promise<CodeRequest[]> {
    console.log(`[Discord] Scanning text channel for approved messages...`);
    const approvedRequests: CodeRequest[] = [];
    let lastMessageId: string | undefined;
    let totalScanned = 0;
    const maxMessages = 500;

    while (totalScanned < maxMessages) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastMessageId) {
        options.before = lastMessageId;
      }

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) {
        break;
      }

      for (const message of messages.values()) {
        if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
          continue;
        }

        // Check for approval emoji in reactions
        const reactions = message.reactions.cache;
        for (const reaction of reactions.values()) {
          if (this.isApprovalEmoji(reaction.emoji)) {
            // Get who approved it and check if they're authorized
            let approvedBy: string | null = null;
            try {
              const users = await reaction.users.fetch();
              // Find the first approved user who reacted
              for (const reactionUser of users.values()) {
                if (this.isApprovedUser(reactionUser.username)) {
                  approvedBy = reactionUser.username;
                  break;
                }
              }
            } catch (error) {
              console.error('[Discord] Error fetching reaction users:', error);
            }

            // Skip if no authorized user approved
            if (!approvedBy) {
              continue;
            }

            console.log(`[Discord] Found approved message: ${message.id} by ${approvedBy}`);
            this.sessionProcessed.add(message.id);
            const request = await this.buildCodeRequest(message, approvedBy);
            approvedRequests.push(request);
            break;
          }
        }

        lastMessageId = message.id;
      }

      totalScanned += messages.size;
      console.log(`[Discord] Scanned ${totalScanned} messages...`);
    }

    approvedRequests.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    console.log(`[Discord] Text channel scan complete. Found ${approvedRequests.length} approved requests.`);
    return approvedRequests;
  }

  async disconnect(): Promise<void> {
    console.log('[Discord] Disconnecting...');
    this.client.destroy();
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && channel instanceof TextChannel) {
      await channel.send(content);
    }
  }

  async replyToMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && channel instanceof TextChannel) {
      const message = await channel.messages.fetch(messageId);
      await message.reply(content);
    }
  }
}
