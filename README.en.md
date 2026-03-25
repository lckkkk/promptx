# PromptX

[中文 README](README.md)

PromptX is a local AI agent workspace.

It organizes `Codex`, `Claude Code`, and `OpenCode` into a cleaner workflow:

```text
Task -> Project -> Directory -> Thread -> Run -> Diff
```

You keep using the agent CLI you already know, while PromptX brings inputs, project binding, execution logs, final replies, and code diffs into one workspace.

## Quick Start

### Requirements

- Recommended: `Node 22 LTS`
- Currently compatible with stable `Node 20 / 22 / 24`
- At least one supported engine installed locally:
  - `codex --version`
  - `claude --version`
  - `opencode --version`

### Install

```bash
npm install -g @muyichengshayu/promptx
promptx doctor
```

### Start

Default URL: `http://127.0.0.1:3000`

```bash
promptx start
promptx status
promptx stop
```

### How To Use

1. Create a task and prepare the context you want to send
2. Bind the task to a project
3. Choose a working directory and engine for that project
4. Send and review execution logs, final replies, and code diffs on the same page

## Core Features

- Structured input: text, images, `md`, `txt`, and `pdf`
- Project reuse: keep a stable directory and engine/thread context
- Visible process: inspect logs, final replies, and run history
- Built-in diff review: inspect workspace, accumulated task, or per-run changes
- Multi-engine support: `Codex`, `Claude Code`, `OpenCode`
- Remote access: connect from mobile or external networks through Relay

## Screenshots

### Workspace

![PromptX workspace](docs/assets/workbench-overview.jpg)

### Settings

![PromptX settings](docs/assets/settings-panel.jpg)

### Mobile

![PromptX mobile](docs/assets/mobile-remote.jpg)

## Why It Helps

- Keeps long-running tasks out of scattered terminal tabs and notes
- Avoids re-explaining directories, projects, and context every round
- Lets you review process and result together, not just the final answer
- Makes code review easier with built-in diff inspection
- Keeps tasks accessible on mobile when you are away from your desk

## Good Fit For

- Preparing requirements, screenshots, logs, and files before sending
- Reusing the same project and directory across many rounds
- Reviewing execution logs, final output, and code changes together
- Exposing local PromptX to phones or external networks through Relay

## Development

```bash
pnpm install
pnpm dev
pnpm build
```

Workspace structure:

- `apps/web`: Vue 3 + Vite frontend
- `apps/server`: Fastify backend
- `apps/runner`: standalone runner process
- `packages/shared`: shared constants and event protocol

## Remote Access

For Relay setup, see:

- `docs/relay-quickstart.md`

That guide covers:

- Connecting a local PromptX client to Relay
- Starting and managing Relay on a server
- Multi-tenant subdomain setup
- `promptx relay tenant add/list/remove`
- `promptx relay start/stop/restart/status`

## Zentao Extension

The repository includes a Zentao Chrome extension at `apps/zentao-extension`.

Notes:

- The published npm package does not include this extension directory
- If you need it, clone the repo and load it manually

Steps:

1. Open `chrome://extensions`
2. Enable developer mode
3. Click “Load unpacked”
4. Select `apps/zentao-extension`

## Notes

- PromptX is currently optimized for local-first, mostly single-user workflows
- Different engines may expose different tool capabilities and event richness
- Use Relay if you need cross-device access
- Runtime data is stored under `~/.promptx/`

## License

PromptX is licensed under `Apache-2.0`. See `LICENSE`.
