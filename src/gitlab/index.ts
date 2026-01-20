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

  constructor(gitlabUrl: string, token: string, projectId: string) {
    this.projectId = encodeURIComponent(projectId);
    this.client = axios.create({
      baseURL: `${gitlabUrl}/api/v4`,
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
      },
    });
  }

  async createMergeRequest(options: MergeRequestOptions): Promise<MergeRequestResult> {
    console.log(`[GitLab] Creating merge request: ${options.title}`);

    try {
      const response = await this.client.post(`/projects/${this.projectId}/merge_requests`, {
        source_branch: options.sourceBranch,
        target_branch: options.targetBranch,
        title: options.title,
        description: options.description,
        remove_source_branch: true,
      });

      let data = response.data;

      // If response is an array, something unexpected happened
      // Try to find existing MR for this branch
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
      if (error.response) {
        console.error(`[GitLab]   Status: ${error.response.status}`);
        console.error(`[GitLab]   Data: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`[GitLab]   Error: ${error.message}`);
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
