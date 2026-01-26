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
import { Storage } from '../storage';

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
}

export class DiscordBot {
  private client: Client;
  private channelIds: string[];
  private approvalEmoji: string;
  private approvedUsers: string[];
  private privateChannelIds: string[];
  private events: DiscordBotEvents;
  private storage: Storage;
  private sessionProcessed: Set<string> = new Set();

  constructor(channelIds: string[], approvalEmoji: string, approvedUsers: string[], privateChannelIds: string[], events: DiscordBotEvents, storage: Storage) {
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
      let isInMonitoredChannel = this.channelIds.includes(message.channelId) || this.privateChannelIds.includes(message.channelId);

      // If it's a thread, check if the parent is one of our monitored channels (public or private)
      if (!isInMonitoredChannel && channel.isThread()) {
        const parentId = channel.parentId || '';
        isInMonitoredChannel = this.channelIds.includes(parentId) || this.privateChannelIds.includes(parentId);
      }

      if (!isInMonitoredChannel) {
        return;
      }

      console.log(`[Discord] Reaction detected on message ${message.id} in monitored channel`);

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

      if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
        console.log(`[Discord] Message ${message.id} already processed, skipping`);
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

      // Only handle messages in threads for ideation responses
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

      // This is a user response in an ideation thread
      await this.handleIdeationResponse(message, username);
    } catch (error) {
      console.error('[Discord] Error handling new message:', error);
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

    // Scan regular (public) emoji-based approval channels
    for (const channelId of this.channelIds) {
      try {
        console.log(`[Discord] Scanning channel: ${channelId} (public, emoji-based)`);
        const channel = await this.client.channels.fetch(channelId);

        if (!channel) {
          console.error(`[Discord] Channel ${channelId} not found. Check DISCORD_CHANNEL_ID in .env`);
          continue;
        }

        console.log(`[Discord] Channel ${channelId} type: ${channel.type}`);

        let requests: CodeRequest[] = [];

        // Handle Forum Channel (type 15)
        if (channel.type === ChannelType.GuildForum) {
          requests = await this.scanForumChannel(channel as ForumChannel);
        }
        // Handle Text Channel (type 0)
        else if (channel instanceof TextChannel) {
          requests = await this.scanTextChannel(channel);
        } else {
          console.error(`[Discord] Unsupported channel type for ${channelId}:`, channel.type);
        }

        allApprovedRequests.push(...requests);
      } catch (error) {
        console.error(`[Discord] Error scanning channel ${channelId}:`, error);
      }
    }

    // Scan private channels (with ideation phase)
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
