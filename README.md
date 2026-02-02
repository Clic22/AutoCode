# AutoCode

A Discord-driven automated code generation system that leverages Claude AI to generate, implement, and review code features with automatic GitLab merge request creation.

## Overview

AutoCode creates a fully automated workflow that:
- Accepts feature requests via Discord messages
- Uses Claude AI to analyze requirements and generate implementation proposals
- Implements code with automatic quality review and retry loops
- Creates GitLab merge requests automatically
- Handles feedback loops through GitLab MR comments

## Features

- **Ideation Phase** - Optional clarifying questions via Discord threads before implementation
- **6-Phase Workflow** - Analysis, Implementation, QA Review, Commit, Push, and MR Creation
- **Automatic QA** - Claude reviews its own code with up to 3 retry attempts
- **Feedback Loop** - Monitors GitLab MR comments and re-implements based on feedback
- **Concurrent Processing** - Handles up to 3 simultaneous requests via workspace isolation
- **Resume Support** - Resumes incomplete workspaces from previous runs

## Prerequisites

- Node.js (v18+)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and configured
- GitLab account with personal access token
- Discord bot token and server

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Clic22/AutoCode.git
   cd AutoCode
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on `.env.example`:
   ```env
   DISCORD_BOT_TOKEN=your_discord_bot_token
   DISCORD_CHANNEL_ID=your_channel_id
   APPROVAL_EMOJI=✅
   PRIVATE_CHANNEL_IDS=  # Optional, for ideation phase
   GITLAB_URL=https://gitlab.com
   GITLAB_TOKEN=your_gitlab_personal_access_token
   GITLAB_REPO_URL=https://gitlab.com/username/repo.git
   GITLAB_PROJECT_ID=username/repo
   WORKSPACES_DIR=./workspaces
   CLAUDE_CLI_PATH=claude
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Start the bot:
   ```bash
   npm start
   ```

For development with auto-reload:
```bash
npm run dev
```

## Usage

### Basic Workflow

1. Post a feature request message in the monitored Discord channel
2. React with the approval emoji (default: ✅) to start processing
3. AutoCode will:
   - Analyze your request
   - Generate code with Claude
   - Perform QA review (auto-retries if issues found)
   - Push to GitLab and create a merge request

### Feedback Loop

1. Review the created MR on GitLab
2. Add comments with your feedback
3. AutoCode automatically re-implements based on feedback (up to 3 rounds)

### Ideation Phase (Optional)

For complex features, post in a configured private channel to trigger clarifying questions before implementation.

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `DISCORD_BOT_TOKEN` | Discord bot token | Yes |
| `DISCORD_CHANNEL_ID` | Channel(s) to monitor (comma-separated) | Yes |
| `GITLAB_URL` | GitLab instance URL | Yes |
| `GITLAB_TOKEN` | GitLab personal access token | Yes |
| `GITLAB_REPO_URL` | Target repository URL | Yes |
| `GITLAB_PROJECT_ID` | GitLab project identifier | Yes |
| `APPROVAL_EMOJI` | Emoji to trigger processing | No (default: ✅) |
| `PRIVATE_CHANNEL_IDS` | Channels for ideation phase | No |
| `APPROVED_USERS` | Authorized Discord usernames | No |
| `WORKSPACES_DIR` | Directory for git worktrees | No (default: ./workspaces) |
| `CLAUDE_CLI_PATH` | Path to Claude CLI | No (default: claude) |

## Project Structure

```
autocode/
├── src/
│   ├── index.ts          # Main orchestrator & workflow engine
│   ├── config/           # Environment configuration
│   ├── discord/          # Discord bot integration
│   ├── git/              # Git operations
│   ├── gitlab/           # GitLab API & MR monitoring
│   ├── claude/           # Claude CLI orchestrator
│   ├── storage/          # Persistent state management
│   └── workspace/        # Workspace management
├── dist/                 # Compiled JavaScript
├── workspaces/           # Runtime workspace directories
└── autocode-data.json    # Persistent state file
```

## Tech Stack

- **TypeScript** - Type-safe application code
- **discord.js** - Discord bot integration
- **simple-git** - Git operations
- **axios** - HTTP client for GitLab API
- **Claude CLI** - AI code generation

## License

MIT
