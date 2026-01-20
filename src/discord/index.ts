import {
  Client,
  GatewayIntentBits,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  TextChannel,
  Partials,
  Collection,
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
}

export class DiscordBot {
  private client: Client;
  private channelId: string;
  private approvalEmoji: string;
  private events: DiscordBotEvents;
  private storage: Storage;
  private sessionProcessed: Set<string> = new Set();

  constructor(channelId: string, approvalEmoji: string, events: DiscordBotEvents, storage: Storage) {
    this.channelId = channelId;
    this.approvalEmoji = approvalEmoji;
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
      console.log(`[Discord] Monitoring channel: ${this.channelId}`);
      console.log(`[Discord] Approval emoji: ${this.approvalEmoji}`);
    });

    this.client.on('messageReactionAdd', async (reaction, user) => {
      await this.handleReaction(reaction, user);
    });

    this.client.on('error', (error) => {
      console.error('[Discord] Client error:', error);
    });
  }

  private isApprovalEmoji(emoji: { name: string | null; id: string | null; toString: () => string }): boolean {
    const emojiIdentifier = emoji.name || emoji.id;
    return emojiIdentifier === this.approvalEmoji || emoji.toString() === this.approvalEmoji;
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

      if (message.channelId !== this.channelId) {
        return;
      }

      if (!this.isApprovalEmoji(reaction.emoji)) {
        return;
      }

      if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
        console.log(`[Discord] Message ${message.id} already processed, skipping`);
        return;
      }

      this.sessionProcessed.add(message.id);

      console.log(`[Discord] Approval detected on message ${message.id} by ${user.username}`);

      const request = await this.buildCodeRequest(message as Message, user.username || 'unknown');
      await this.events.onRequestApproved(request);
    } catch (error) {
      console.error('[Discord] Error handling reaction:', error);
    }
  }

  private async buildCodeRequest(message: Message, approvedBy: string): Promise<CodeRequest> {
    let threadMessages: string[] = [];

    if (message.hasThread && message.thread) {
      try {
        const thread = message.thread;
        const messages = await thread.messages.fetch({ limit: 100 });
        threadMessages = messages
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => `${m.author.username}: ${m.content}`)
          .filter((content) => content.trim());
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
    console.log('[Discord] Scanning channel for approved messages...');

    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      console.error('[Discord] Could not find or access channel');
      return [];
    }

    const approvedRequests: CodeRequest[] = [];
    let lastMessageId: string | undefined;
    let totalScanned = 0;
    const maxMessages = 500; // Limit to prevent excessive API calls

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
        // Skip if already processed
        if (this.storage.isProcessed(message.id) || this.sessionProcessed.has(message.id)) {
          continue;
        }

        // Check for approval emoji in reactions
        const reactions = message.reactions.cache;
        for (const reaction of reactions.values()) {
          if (this.isApprovalEmoji(reaction.emoji)) {
            // Found an approved message
            console.log(`[Discord] Found approved message: ${message.id}`);

            // Get who approved it
            let approvedBy = 'unknown';
            try {
              const users = await reaction.users.fetch();
              const approver = users.first();
              if (approver) {
                approvedBy = approver.username;
              }
            } catch (error) {
              console.error('[Discord] Error fetching reaction users:', error);
            }

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

    // Sort by timestamp (oldest first)
    approvedRequests.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    console.log(`[Discord] Scan complete. Found ${approvedRequests.length} approved requests to process.`);
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
