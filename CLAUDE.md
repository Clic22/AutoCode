# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AutoCode is a Discord-driven automated code generation system that processes feature requests from Discord, uses Claude AI to generate and review code, manages Git operations, and creates GitLab merge requests with feedback loop handling.

## Build & Development Commands

```bash
npm run build       # Compile TypeScript → dist/
npm run dev         # Run with ts-node (development)
npm start           # Run compiled JavaScript
npm run watch       # Watch mode - compile on changes
```

## Architecture

The application follows a layered event-driven architecture:

```
User Input (Discord Bot)
    ↓
Orchestration (AutoCode class in src/index.ts)
    ↓
Domain Modules (Claude, Git, GitLab, Storage)
    ↓
External Systems (Discord API, Git, GitLab API, Supabase)
```

### Core Modules

- **src/index.ts** - Main orchestrator (`AutoCode` class). Manages request lifecycle, queue system (max 3 concurrent), coordinates all submodules, handles 8 event types, workspace state transitions
- **src/discord/index.ts** - `DiscordBot` class. Handles reactions, thread messages, ideation conversations, cross-channel routing
- **src/claude/index.ts** - `ClaudeOrchestrator` class. Wraps Claude CLI for 6-phase workflow (Ideation → Analysis → Implementation → QA Review → Commit → Push/MR)
- **src/git/index.ts** - `GitManager` class. Git worktree management with async mutex for concurrent safety. Base repo in `workspaces/base-repo/`, isolated worktrees per request
- **src/gitlab/index.ts** - `GitLabClient` class. MR creation, comment fetching, API interactions
- **src/storage/index.ts** and **src/storage/supabase.ts** - Dual storage backends (JSON file or Supabase cloud)
- **src/config/index.ts** - Environment variable loading
- **src/workspace/index.ts** - Filesystem workspace utilities

### Key Patterns

1. **Workspace Isolation**: Each request gets its own Git worktree for parallel processing without conflicts
2. **Async Mutex**: Protects shared base repository during fetch/clone operations
3. **Deduplication**: Session-level set + storage-level checks prevent double-processing
4. **State Machine**: Workspaces progress through 15 statuses (e.g., `ideation_pending` → `analysis` → `implementation` → `review` → `mr_created` → `completed`)
5. **Feedback Loop**: Discord thread comments trigger re-implementation cycles

### Workflow Phases

1. **Ideation** (optional): Clarifying questions via Discord thread
2. **Base Branch Selection**: User selects preview/stable/beta/custom branch
3. **Analysis**: Discord conversation → development prompt
4. **Implementation**: Code generation (supports previous feedback context)
5. **QA Review**: Self-review with up to 3 retry attempts
6. **Git Operations**: Commit, push, create MR

### Storage Data Model

```typescript
interface ProcessedData {
  processedMessageIds: string[]           // Deduplication
  workspaces: Record<string, WorkspaceInfo>
  mrUrlIndex: Record<string, string>      // MR URL → messageId
  branchIndex: Record<string, string>     // Branch → messageId
  sourceMessageIndex: Record<string, string> // Public → internal messageId
  threadIndex: Record<string, string>     // Discord thread → messageId
}
```

## Configuration

Required environment variables:
- `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` (comma-separated)
- `GITLAB_TOKEN`, `GITLAB_REPO_URL`, `GITLAB_PROJECT_ID`

Optional:
- `PRIVATE_CHANNEL_IDS` - Enables ideation phase
- `STORAGE_TYPE` - `json` (default) or `supabase`
- `APPROVED_USERS` - Comma-separated authorized usernames
