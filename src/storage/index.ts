import fs from 'fs/promises';
import path from 'path';

export interface ProcessedData {
  processedMessageIds: string[];
  lastScanTimestamp: number;
}

export class Storage {
  private filePath: string;
  private data: ProcessedData;

  constructor(storagePath: string) {
    this.filePath = storagePath;
    this.data = {
      processedMessageIds: [],
      lastScanTimestamp: 0,
    };
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(content);
      console.log(`[Storage] Loaded ${this.data.processedMessageIds.length} processed message IDs`);
    } catch (error) {
      // File doesn't exist yet, start fresh
      console.log('[Storage] No existing data found, starting fresh');
      this.data = {
        processedMessageIds: [],
        lastScanTimestamp: 0,
      };
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }

  isProcessed(messageId: string): boolean {
    return this.data.processedMessageIds.includes(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    if (!this.data.processedMessageIds.includes(messageId)) {
      this.data.processedMessageIds.push(messageId);
      await this.save();
    }
  }

  async updateLastScan(): Promise<void> {
    this.data.lastScanTimestamp = Date.now();
    await this.save();
  }

  getLastScanTimestamp(): number {
    return this.data.lastScanTimestamp;
  }

  getProcessedIds(): string[] {
    return [...this.data.processedMessageIds];
  }
}
