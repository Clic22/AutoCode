import http from 'http';

export interface WebhookEvents {
  onMRMerged: (mrUrl: string, sourceBranch: string, mrIid: number) => Promise<void>;
  onMRComment?: (mrUrl: string, sourceBranch: string, mrIid: number, author: string, comment: string) => Promise<void>;
}

export class GitLabWebhookServer {
  private server: http.Server | null = null;
  private port: number;
  private secret: string;
  private events: WebhookEvents;

  constructor(port: number, secret: string, events: WebhookEvents) {
    this.port = port;
    this.secret = secret;
    this.events = events;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        console.error('[GitLab Webhook] Server error:', error);
        reject(error);
      });

      this.server.listen(this.port, () => {
        console.log(`[GitLab Webhook] Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[GitLab Webhook] Forcing server shutdown after timeout');
        resolve();
      }, 5000);

      this.server!.close(() => {
        clearTimeout(timeout);
        console.log('[GitLab Webhook] Server stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only accept POST
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Verify token
    const token = req.headers['x-gitlab-token'];
    if (token !== this.secret) {
      console.log('[GitLab Webhook] Unauthorized request (invalid or missing token)');
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    // Read body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      // Respond immediately
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');

      // Process asynchronously
      this.processWebhook(body).catch((error) => {
        console.error('[GitLab Webhook] Error processing webhook:', error);
      });
    });
  }

  private async processWebhook(body: string): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      console.error('[GitLab Webhook] Invalid JSON payload');
      return;
    }

    // Handle note (comment) events on merge requests
    if (payload.object_kind === 'note' && payload.merge_request && this.events.onMRComment) {
      const mr = payload.merge_request;
      const mrUrl = mr.url;
      const sourceBranch = mr.source_branch;
      const mrIid = mr.iid;
      const author = payload.user?.username || 'unknown';
      const comment = payload.object_attributes?.note || '';

      console.log(`[GitLab Webhook] MR comment by ${author} on !${mrIid}: ${comment.substring(0, 100)}...`);

      await this.events.onMRComment(mrUrl, sourceBranch, mrIid, author, comment);
      return;
    }

    // Filter: only merge_request events with action 'merge'
    if (payload.object_kind !== 'merge_request') {
      console.log(`[GitLab Webhook] Ignoring event: ${payload.object_kind}`);
      return;
    }

    const attrs = payload.object_attributes;
    if (!attrs || attrs.action !== 'merge') {
      console.log(`[GitLab Webhook] Ignoring MR action: ${attrs?.action}`);
      return;
    }

    const mrUrl = attrs.url;
    const sourceBranch = attrs.source_branch;
    const mrIid = attrs.iid;

    console.log(`[GitLab Webhook] MR merged: !${mrIid} (${sourceBranch}) - ${mrUrl}`);

    await this.events.onMRMerged(mrUrl, sourceBranch, mrIid);
  }
}
