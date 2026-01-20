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

      const result: MergeRequestResult = {
        id: response.data.id,
        iid: response.data.iid,
        webUrl: response.data.web_url,
        title: response.data.title,
      };

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

  async getDefaultBranch(): Promise<string> {
    const response = await this.client.get(`/projects/${this.projectId}`);
    return response.data.default_branch || 'main';
  }
}
