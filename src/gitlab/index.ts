import axios, { AxiosInstance } from 'axios';

export interface MergeRequestOptions {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface MergeRequestResult {
  id: number;
  iid: number;
  webUrl: string;
  title: string;
}

export class GitLabClient {
  private client: AxiosInstance;
  private projectId: string;
  private baseUrl: string;
  private token: string;

  constructor(gitlabUrl: string, token: string, projectId: string) {
    // Use numeric project ID if it's a number, otherwise encode the path
    this.projectId = /^\d+$/.test(projectId) ? projectId : encodeURIComponent(projectId);
    this.baseUrl = `${gitlabUrl}/api/v4`;
    this.token = token;
    console.log(`[GitLab] Initialized with baseUrl: ${this.baseUrl}, projectId: ${this.projectId}`);
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
      },
    });
  }

  private async ensureNumericProjectId(): Promise<void> {
    // If projectId is already numeric, we're good
    if (/^\d+$/.test(this.projectId)) {
      return;
    }

    // Get numeric project ID from API
    console.log(`[GitLab] Getting numeric project ID for: ${this.projectId}`);
    try {
      const response = await this.client.get(`/projects/${this.projectId}`);
      const numericId = response.data.id;
      console.log(`[GitLab] Resolved to numeric project ID: ${numericId}`);
      this.projectId = String(numericId);
    } catch (error: any) {
      console.error(`[GitLab] Failed to get project info: ${error.message}`);
    }
  }

  async createMergeRequest(options: MergeRequestOptions): Promise<MergeRequestResult> {
    console.log(`[GitLab] Creating merge request: ${options.title}`);

    // Ensure we have a numeric project ID
    await this.ensureNumericProjectId();

    try {
      const url = `${this.baseUrl}/projects/${this.projectId}/merge_requests`;
      console.log(`[GitLab] POST ${url}`);

      // Use native fetch to avoid any axios issues
      const body = new URLSearchParams();
      body.append('source_branch', options.sourceBranch);
      body.append('target_branch', options.targetBranch);
      body.append('title', options.title);
      body.append('description', options.description);
      body.append('remove_source_branch', 'true');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        redirect: 'manual', // Don't follow redirects automatically
      });

      console.log(`[GitLab] Response status: ${response.status}`);
      console.log(`[GitLab] Response URL: ${response.url}`);
      console.log(`[GitLab] Was redirected: ${response.redirected}`);
      console.log(`[GitLab] Response type: ${response.type}`);

      // If we got a redirect, follow it manually with POST
      if (response.status >= 300 && response.status < 400) {
        const redirectUrl = response.headers.get('location');
        console.log(`[GitLab] Redirect detected! Location: ${redirectUrl}`);

        if (redirectUrl) {
          console.log(`[GitLab] Following redirect with POST...`);
          const redirectResponse = await fetch(redirectUrl, {
            method: 'POST',
            headers: {
              'PRIVATE-TOKEN': this.token,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
          });
          console.log(`[GitLab] Redirect response status: ${redirectResponse.status}`);

          const data: any = await redirectResponse.json();
          console.log(`[GitLab] Redirect response data (first 200 chars): ${JSON.stringify(data).substring(0, 200)}`);

          if (!redirectResponse.ok) {
            throw new Error(data.message || data.error || `HTTP ${redirectResponse.status}`);
          }

          return {
            id: data.id,
            iid: data.iid,
            webUrl: data.web_url,
            title: data.title,
          };
        }
      }

      const data: any = await response.json();
      console.log(`[GitLab] Response data (first 200 chars): ${JSON.stringify(data).substring(0, 200)}`);

      // Check for error response
      if (!response.ok) {
        console.error(`[GitLab] Error response: ${JSON.stringify(data)}`);
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }

      // If response is an array, something unexpected happened
      if (Array.isArray(data)) {
        console.log(`[GitLab] Received array response, looking for existing MR...`);
        return await this.findExistingMR(options.sourceBranch, options.targetBranch);
      }

      const result: MergeRequestResult = {
        id: data.id,
        iid: data.iid,
        webUrl: data.web_url,
        title: data.title,
      };

      // If web_url is missing, try to construct it
      if (!result.webUrl && result.iid) {
        const projectResponse = await this.client.get(`/projects/${this.projectId}`);
        const projectUrl = projectResponse.data.web_url;
        result.webUrl = `${projectUrl}/-/merge_requests/${result.iid}`;
      }

      console.log(`[GitLab] Merge request created: ${result.webUrl}`);
      return result;
    } catch (error: any) {
      console.error(`[GitLab] Failed to create merge request:`);
      console.error(`[GitLab]   Error: ${error.message}`);

      // If MR already exists, try to find and return it
      if (error.message && error.message.includes('already exists')) {
        console.log(`[GitLab] MR already exists, looking for existing one...`);
        return await this.findExistingMR(options.sourceBranch, options.targetBranch);
      }

      throw error;
    }
  }

  async findExistingMR(sourceBranch: string, targetBranch: string): Promise<MergeRequestResult> {
    console.log(`[GitLab] Looking for existing MR: ${sourceBranch} -> ${targetBranch}`);

    const response = await this.client.get(`/projects/${this.projectId}/merge_requests`, {
      params: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        state: 'opened',
      },
    });

    const mrs = response.data;
    if (Array.isArray(mrs) && mrs.length > 0) {
      const mr = mrs[0];
      console.log(`[GitLab] Found existing MR: !${mr.iid} - ${mr.title}`);
      return {
        id: mr.id,
        iid: mr.iid,
        webUrl: mr.web_url,
        title: mr.title,
      };
    }

    throw new Error(`No existing MR found for branch ${sourceBranch}`);
  }

  async getDefaultBranch(): Promise<string> {
    const response = await this.client.get(`/projects/${this.projectId}`);
    return response.data.default_branch || 'main';
  }
}
