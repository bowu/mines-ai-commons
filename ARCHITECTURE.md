# Mines AI Architecture

Last updated: 2026-02-21

## 1. Scope and goals

This document defines the architecture of the Mines AI system so that any engineer or AI agent can understand, build, and deploy the full platform. It covers:

- Frontend web app
- Backend API routes and service modules
- Datastores
- External API dependencies
- Current execution model (local/docker)
- Target sandboxed execution model using GCE VMs
- Multi-tenancy (multiple organizations)
- Multi-user agent access and shared conversations
- Dynamic GPU activation (on-demand GPU with user approval)
- GCP infrastructure, networking, and VM lifecycle
- Concrete commands, code changes, and implementation sequence

## 2. System context

### 2.1 Current deployment topology (local/docker)

```text
Browser (React 19 / Vite 7)
  -> Express 5 API (Node 22 / TypeScript)
      -> PostgreSQL 16
      -> BookStack API (wiki tools)
      -> Brave Search API (web_search tool)
      -> Gemini API (fallback LLM)
      -> AWS Bedrock (Claude Sonnet 4.6 via pi-coding-agent)

BookStack service
  -> MariaDB (BookStack internal DB)
```

Current security problem: the pi-coding-agent session (including `bash`, `read`, `write`, `edit` tools) runs **in the same Node process** as the Express API. Any agent can access the host filesystem, environment variables, database credentials, and network.

### 2.2 Target deployment topology (GKE API + GCE VM sandboxes)

```text
Browser
  -> Nginx Ingress (TLS termination)
      -> API Deployment on GKE (not sandboxed, 2+ replicas)
          -> Cloud SQL for PostgreSQL
          -> BookStack Deployment + MariaDB StatefulSet
          -> GCE VM Manager (create/start/stop/delete VMs)
              -> GCE VM per agent (full VM isolation)
                  -> sandbox-server (Node.js HTTP, port 8888)
                  -> pi-coding-agent sessions (multiple concurrent)
                  -> createCodingTools() (bash/read/write/edit)
                  -> custom tools (web_search, web_fetch, document tools, wiki tools)
                  -> persistent disk (/workspace, survives stop/start)

External APIs (called directly from VMs):
  -> AWS Bedrock (short-lived STS credentials in VM metadata)

API-mediated calls (VM -> API via ILB -> service):
  -> BookStack REST API (API holds admin tokens)
  -> Postgres (API holds DATABASE_URL)
  -> Brave Search API (API holds BRAVE_API_KEY, per-agent rate limits)
```

Key principles:
- **The entire agent runtime lives inside the GCE VM.** The API never executes untrusted code or agent-invoked tools. The only in-process LLM path is the Gemini text-only fallback, which has no tool definitions and cannot access the filesystem or sandbox (see section 16).
- **One VM per agent.** Each agent gets its own VM. Boot disk (OS/tools) is ephemeral; data disk (`/workspace`) is persistent and survives VM swaps.
- **Multiple concurrent conversations** share the same VM and workspace.
- **Multiple users per agent.** Each user has their own conversations, or users can join shared conversations. All share the same workspace.
- **Multi-tenant.** Organizations (universities) are isolated via row-level `org_id` filtering.
- **Agents always start on CPU.** GPU is activated on-demand when the agent requests it and the user approves. Data disk detaches from CPU VM and attaches to GPU VM. Reverse when done.
- **VMs are stopped on idle** (not deleted). Data disk survives. Cost drops to disk-only storage.
- **No warm pools, no snapshots, no K8s sandboxing.** Just create, start, stop, start, stop.

### 2.3 Why GCE VMs (not K8s pods, not Agent Sandbox)

Research agents need full Linux capability: browsers (Playwright/Puppeteer), GPU access for ML training, arbitrary package installation (`pip install`, `apt install`), database servers, and more.

- **gVisor (Agent Sandbox)**: reimplements ~60% of syscalls in userspace. Breaks browsers, some native packages, GPU access. Too restrictive.
- **Kata Containers (K8s)**: full VM kernel but GPU passthrough is complex. Adds K8s CRD overhead.
- **GCE VMs**: full VM, real kernel, native GPU support, persistent disk built-in, simple GCE API. No K8s complexity for sandbox layer.

The API server runs on GKE. The sandboxes run on GCE VMs. The `SandboxClient` abstraction means the API doesn't care where the sandbox runs — in local dev, it's just `localhost:8888`.

## 3. Service inventory

### 3.1 Frontend service

- Runtime: React 19 + Vite 7 + Tailwind CSS 4 + shadcn/ui
- Entry: `client/src/main.tsx` -> `client/src/App.tsx`
- Main pages:
  - `WikiPage` (`/wiki`) -- BookStack iframe
  - `AgentsPage` (`/agents`, `/agents/:agentId`) -- chat + workspace
  - `SkillsPage` (`/skills`) -- CRUD skill library
- Core frontend responsibilities:
  - Agent chat UI with SSE streaming, tool timeline, thinking blocks
  - Model selector (`gemini-3.1-pro` / `sonnet-4.6`)
  - GPU approval dialog (agent requests GPU, user approves/denies)
  - Multiple concurrent conversations per agent (private + shared)
  - Agent/skill CRUD views
  - Workspace browser/upload/preview UI
  - File preview overlays for generated artifacts (PDF, DOCX, XLSX, PPTX, HTML, images)

### 3.2 API service

- Runtime: Express 5 + TypeScript, compiled via `tsc` to `dist/`
- Entry: `src/index.ts`
- Mounted routes (current state):
  - `/api/health`
  - `/api/auth` -> `src/routes/auth.ts` (bypass login + OIDC login/callback + logout + current user)
  - `/api/agents` -> `src/routes/agents.ts` (CRUD agents, skill install/uninstall)
  - `/api/skills` -> `src/routes/skills.ts` (CRUD skills, upload data sources)
  - `/api/agent-chat` -> `src/routes/agent-chat.ts` (SSE chat endpoint, runs pi-agent in-process)
  - `/api/workspace` -> `src/routes/workspace.ts` (file ops on host filesystem)
- Removed routes and services (vector similarity search pipeline — code/runtime removal complete, migration seed cleanup pending):
  - `/api/chat` (RAG chat), `/api/admin` (BookStack sync + KB stats), `/api/crawl` (Firecrawl) — unmounted from `src/index.ts`, route files deleted
  - `search_knowledge_base` tool — removed from `src/services/pi-agent/tools.ts` and ChatView UI mapping
  - `src/services/rag.ts`, `src/services/embeddings.ts`, `src/services/bookstack.ts`, `src/services/firecrawl.ts` — deleted
  - Agents use `web_search`, `wiki_search`, and `web_fetch` tools for agentic search
  - **Pending** [GA blocker, owner: platform-lead]: `Mines Knowledge Base` seed skill in migration files `001`/`002` still references `search_knowledge_base` tool type (see section 16, Phase 8 items 4-5)

Target-state routes (do not exist yet, to be created):
  - `/api/sandbox` -> `src/routes/sandbox.ts` (ensure/heartbeat/release VM endpoints)
  - `/api/agents` gains VM lifecycle on create/delete
  - `/api/agent-chat` changes from in-process pi-agent to VM proxy
  - `/api/workspace` changes from host filesystem to VM proxy

### 3.3 Data services

- **PostgreSQL 16**
  - Connection: `src/db/index.ts` (multiple pools: app + internal roles)
  - Schema source of truth: `src/db/schema.ts` (Drizzle schema + RLS policies)
  - Migration mechanism: Drizzle-kit SQL in `src/db/migrations/` (`pnpm db:generate`, `pnpm db:migrate`)
  - Legacy custom migration runner and `schema_migrations` table have been removed
  - pgvector extension is not used
- **BookStack**
  - Wiki tools: `src/services/wiki/bookstack.ts` (search, read page, list books)
- **MariaDB** (BookStack internal, not accessed directly by Mines AI)

### 3.4 AI/runtime services

- **pi-coding-agent** (primary path, `@mariozechner/pi-coding-agent@^0.53.0`):
  - Session lifecycle: `src/services/pi-agent/session.ts` (current; moves to sandbox-server)
  - Stream mapping: `src/services/pi-agent/stream.ts` (current; moves to sandbox-server)
  - Custom tools: `src/services/pi-agent/tools.ts` (current; moves to sandbox-server)
  - Model: Claude Sonnet 4.6 on AWS Bedrock (`global.anthropic.claude-sonnet-4-6`)
  - Context window: 200K tokens, max output: 64K tokens
- **Gemini orchestrator** (text-only fallback, no tools — see section 16):
  - `src/services/agent/orchestrator.ts`
  - No tool definitions passed to Gemini. The orchestrator files (`types.ts`, `tools/*`) are legacy and should be removed (Phase 8 cleanup). Gemini fallback provides degraded-mode text responses only.
- **Removed**: RAG chat pipeline (`src/services/rag.ts`, `src/services/embeddings.ts`, `src/services/bookstack.ts`) — deleted, replaced by agentic search tools

### 3.5 External services

| Service | Env var | Usage |
|---------|---------|-------|
| AWS Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Claude Sonnet 4.6 inference |
| Gemini API | `GEMINI_API_KEY` | Fallback LLM |
| Brave Search | `BRAVE_API_KEY` | web_search tool |
| BookStack REST | `BOOKSTACK_URL`, `BOOKSTACK_API_TOKEN_ID`, `BOOKSTACK_API_TOKEN_SECRET` | Wiki tools (`src/services/wiki/bookstack.ts`) |

## 4. Backend architecture by route

### 4.1 Agent route set (`/api/agents`)

- CRUD agents in Postgres (scoped to `org_id`)
- On create: create data disk + CPU VM (always e2-medium; GPU activated on-demand) (target state)
- On delete: delete VM + data disk (target state)
- Share agent with other users in org (owner/editor/viewer ACL enforced in route middleware)
- Toggle/install/uninstall skills for agents
- Invalidate cached agent sessions after agent/skill changes

Key module interactions: `query()`, `ensureAgentDirs()`, `removeAgentDirs()`, `invalidateSession()`, `installSkillPackage()`, `uninstallSkillPackage()`

### 4.2 Skill route set (`/api/skills`)

- CRUD skill definitions in Postgres
- Upload data-source files for skills (multipart via multer)
- Generate library package with `SKILL.md` and `manifest.json`
- Resync installed skill copies into agent workspaces

Key module: `src/services/skills/packages.ts`

### 4.3 Agent chat route set (`/api/agent-chat`)

Entry point for all agent interactions. Current flow (file: `src/routes/agent-chat.ts`):

1. Receive POST `/:agentId/chat` with `{ message, sessionId, outputFolder, model }`
2. Resolve/create chat session in Postgres, save user message
3. Load enabled+installed skills, compose system prompt via `buildSystemPrompt()`
4. Set up SSE response headers
5. If model = `sonnet-4.6`:
   - Build custom tools: skill tools + web tools + document tools + wiki tools
   - Fetch last 50 chat messages for history injection
   - Get or create pi-coding-agent session via `getPiSession()`
   - Stream events via `streamPiAgent()` async generator
6. If model = `gemini-3.1-pro`: use Gemini text-only path (no tools, no sandbox — see note below)
7. Sonnet errors fall back to Gemini text-only path
8. Post-stream: sanitize `file://` links, persist assistant message with segments/tool_calls
9. End SSE stream

SSE event types (current): `session`, `text`, `thinking`, `tool_call`, `tool_result`, `error`, `done`

See section 8.4 for the canonical SSE event schema (current + target events).

Additional endpoints:
- GET `/sessions/:sessionId/messages` -- chat history for a session
- GET `/:agentId/latest` -- latest session for the authenticated user for an agent

### 4.4 Workspace route set (`/api/workspace`)

- List file tree, read/download files, upload, mkdir, move, delete
- Path sanitization: `sanitizePath()` prevents `../` traversal
- 50MB per-workspace size limit, 10MB per upload, single file per request (`upload.single('file')`)
- Current storage: host filesystem at `data/workspaces/<orgId>/<agentId>/`
- Target: proxy all operations to VM:8888 file endpoints

### 4.5 Removed routes

The following routes and services have been removed. They depended on the vector similarity search pipeline (`crawled_pages` + pgvector + Gemini embeddings) which has been replaced by agentic search tools.

| What was removed | What it did | Replacement |
|---|---|---|
| `/api/chat` (`src/routes/chat.ts`) | RAG chat: embed query → pgvector search → Gemini answer | Agent tools: `web_search`, `wiki_search`, `web_fetch` |
| `/api/admin` (`src/routes/admin.ts`) | BookStack sync into `crawled_pages` + embedding generation, KB stats | None — BookStack wiki tools (`src/services/wiki/bookstack.ts`) remain for live search |
| `/api/crawl` (`src/routes/crawl.ts`) | Firecrawl web crawl jobs | None — no vector ingestion pipeline |
| `search_knowledge_base` tool | pgvector similarity search on `crawled_pages` | Agentic tool composition (`web_search` + `wiki_search` + `web_fetch`) |
| `src/services/rag.ts`, `src/services/embeddings.ts` | RAG pipeline + Gemini embedding generation | Deleted |
| `src/services/bookstack.ts` | BookStack page sync → `crawled_pages` + embeddings | Deleted (wiki tools in `src/services/wiki/bookstack.ts` are separate and remain) |

## 5. Data architecture

### 5.1 Core tables

Defined by `src/db/schema.ts` and materialized via Drizzle-kit migrations in `src/db/migrations/`.

Current migration baseline (as of 2026-02-20):
- `0000_overjoyed_zombie.sql` (core tables, multi-tenancy columns, RLS policies, base roles)
- `0001_roles_and_grants.sql`
- `0002_seed_and_backfill.sql`
- `0003_functional_indexes.sql`
- `0004_drop_legacy_schema_migrations.sql`

Core app tables:
- `organizations`
- `users`
- `agents`
- `skills`
- `agent_skills`
- `agent_access`
- `agent_chat_sessions`
- `agent_chat_messages`

Legacy vector-search tables and services (`crawled_pages`, `page_chunks`, `crawl_jobs`, `chat_history`) are removed. Agentic search now uses tools (`web_search`, `wiki_search`, `web_fetch`) instead of similarity search.

### 5.2 Multi-tenancy and multi-user tables (target state)

```sql
-- Organizations (universities, research groups, etc.)
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- 'Colorado School of Mines'
  slug TEXT UNIQUE NOT NULL,             -- 'mines'
  domain TEXT NOT NULL,                    -- 'mines.edu' (extracted from SSO email, stored lowercase)
  settings JSONB DEFAULT '{}',           -- per-org limits: max_agents, default_machine_type, etc.
  created_at TIMESTAMP DEFAULT NOW()
);

-- Users (populated from SSO on first login)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,                     -- stored lowercase (canonicalized on insert)
  name TEXT,
  role TEXT DEFAULT 'member',            -- 'admin' (org admin), 'member'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Case-insensitive unique indexes. These are the SOLE uniqueness constraints on domain/email
-- (no plain UNIQUE on the column). App layer canonicalizes to lowercase on insert; the
-- functional index is the DB-level safety net AND the ON CONFLICT target.
-- ON CONFLICT clauses must reference the index expression: ON CONFLICT ((LOWER(domain))).
CREATE UNIQUE INDEX organizations_domain_lower ON organizations (LOWER(domain));
CREATE UNIQUE INDEX users_email_lower ON users (LOWER(email));

-- Agent access control
CREATE TABLE agent_access (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'viewer',            -- 'owner', 'editor', 'viewer'
  PRIMARY KEY (agent_id, user_id)
);

-- Add org_id to existing tables
ALTER TABLE agents ADD COLUMN org_id UUID REFERENCES organizations(id);
ALTER TABLE skills ADD COLUMN org_id UUID REFERENCES organizations(id);

-- Add user tracking to chat
ALTER TABLE agent_chat_sessions ADD COLUMN created_by UUID REFERENCES users(id);
ALTER TABLE agent_chat_sessions ADD COLUMN shared BOOLEAN DEFAULT false;
ALTER TABLE agent_chat_messages ADD COLUMN user_id UUID REFERENCES users(id);
```

Access roles:
- **owner**: full control — chat, upload, configure agent, share with others, delete
- **editor**: can chat, upload files, create conversations
- **viewer**: can read conversations and workspace, cannot send messages

**Tenant isolation invariant**: Every data query must be scoped to `org_id`.

Tables with direct `org_id` column: `organizations`, `users`, `agents`, `skills`.

Tables without `org_id` (scoped via joins):
- `agent_access` — scoped via `agent_id` -> `agents.org_id`
- `agent_chat_sessions` — scoped via `agent_id` -> `agents.org_id`
- `agent_chat_messages` — scoped via `session_id` -> `agent_chat_sessions.agent_id` -> `agents.org_id`
- `agent_skills` — scoped via `agent_id` -> `agents.org_id`

**Rule**: All queries on chat tables must join through `agents` to verify org membership. Never query `agent_chat_sessions` or `agent_chat_messages` by session/message ID alone without verifying the agent belongs to the current org. Example:

```sql
-- CORRECT: scoped through agent ownership
SELECT m.* FROM agent_chat_messages m
JOIN agent_chat_sessions s ON m.session_id = s.id
JOIN agents a ON s.agent_id = a.id
WHERE a.org_id = $1 AND s.id = $2;

-- WRONG: unscoped, allows cross-tenant access
SELECT * FROM agent_chat_messages WHERE session_id = $1;
```

### 5.3 Schema changes for VM-backed agents (target state)

```sql
-- VM lifecycle fields on agents table
ALTER TABLE agents ADD COLUMN machine_type TEXT DEFAULT 'e2-medium';
ALTER TABLE agents ADD COLUMN gpu_type TEXT;                -- null = CPU only; 'nvidia-tesla-t4', 'nvidia-l4', etc.
ALTER TABLE agents ADD COLUMN gpu_active BOOLEAN DEFAULT false; -- true when currently on a GPU VM
ALTER TABLE agents ADD COLUMN vm_status TEXT DEFAULT 'none'; -- 'none', 'creating', 'running', 'upgrading', 'stopping', 'stopped'
ALTER TABLE agents ADD COLUMN vm_name TEXT;                  -- GCE instance name: 'sandbox-<agentId>'
ALTER TABLE agents ADD COLUMN vm_ip TEXT;                    -- internal IP for API -> VM communication
ALTER TABLE agents ADD COLUMN data_disk_name TEXT;           -- persistent disk name: 'workspace-<agentId>'
ALTER TABLE agents ADD COLUMN vm_zone TEXT;                   -- GCE zone where data disk was created (disk affinity)
ALTER TABLE agents ADD COLUMN vm_token_generation INT DEFAULT 0; -- embedded in JWT; checked by validateVMToken on every internal route
-- vm_token_generation MUST be incremented BEFORE every lifecycle action that invalidates trust:
--   create (before VM creation), stop, delete, resume (before start), CPU->GPU swap (before CPU delete), GPU->CPU swap (before GPU delete)
-- Tokens are always minted with the post-increment value. One increment per transition.
ALTER TABLE agents ADD COLUMN last_activity_at TIMESTAMP DEFAULT NOW();
```

No separate `sandbox_sessions` table needed. The VM is tied to the agent, not to a session. Multiple chat sessions (from multiple users) share the same VM.

### 5.4 File-system data

- `data/workspaces/<orgId>/<agentId>/` -- local/dev workspace artifacts (target VM path is `/workspace`)
- `data/skills/<orgId>/<skillId>/` -- skill package artifacts scoped by organization
- legacy non-org-prefixed paths are migrated by `pnpm db:migrate-files` (idempotent)

### 5.5 Session/cache behavior

Current state:
- In-memory `Map<string, CachedSession>` in `src/services/pi-agent/session.ts`
- Keyed by `agentId`, stores pi-coding-agent `CreateAgentSessionResult`
- Cache invalidated on agent updates and skill changes
- **Not durable** across API pod restarts

Target state:
- Pi-agent sessions live inside the sandbox-server on the GCE VM
- Multiple sessions per VM (one per conversation), keyed by `sessionId`
- Sessions persist as long as the VM is running
- On VM stop: sessions lost (RAM cleared), but disk persists
- On VM restart: sessions re-created from chat history in Postgres (same as current behavior)

## 6. Tooling architecture

### 6.1 pi-coding-agent built-in tools (via `createCodingTools(workspaceDir)`)

- `read` -- read file contents
- `write` -- create/overwrite files
- `edit` -- text replacement in files
- `bash` -- arbitrary shell commands scoped to workspace cwd

### 6.2 Custom tool layers (defined in `src/services/pi-agent/tools.ts`)

Always-on platform tools:
- `web_search` -- Brave Search API (returns titles, URLs, descriptions)
- `web_fetch` -- fetch URL and extract readable text. Returns page content directly as markdown-style text (title header + body) rather than JSON metadata, so the agent can process more pages within context limits.

Document tools (always-on, agent-scoped):
- `read_pdf`, `read_docx`, `read_xlsx` -- read binary document formats
- `create_docx` -- markdown to Word via pandoc
- `create_xlsx` -- structured data to Excel via exceljs
- `create_pptx` -- structured slides to PowerPoint via pptxgenjs

Wiki tools (always-on):
- `wiki_search` -- search BookStack pages/books/chapters. Returns 800-char previews and tags so the agent can decide relevance before calling `wiki_read_page`.
- `wiki_read_page` -- read full wiki page by ID (returns markdown or HTML-stripped text, up to 50K chars)
- `wiki_list_books` -- list all books

VM lifecycle tools (target state, defined in sandbox-server):
- `request_gpu` -- agent requests GPU activation. Sends SSE event `gpu_request` to browser for user approval. Returns approval/denial status.
- `release_gpu` -- agent signals GPU work is complete. Triggers downgrade back to CPU VM.

Skill-derived tools:
- `getCustomToolsForSkills()` maps `skill.tool_type` to tool factories via `TOOL_REGISTRY`

### 6.3 Tool placement in target state

**All tools run inside the GCE VM.** The VM is a full Linux environment. Tools can:
- Execute arbitrary bash commands, install any packages
- Run browsers (Playwright, Puppeteer, headless Chrome)
- Access GPUs for ML training (on GPU-enabled VMs)
- Run database servers, web servers, or any other processes
- Make outbound HTTPS calls to external APIs

**External service access from VMs:**
- Direct from VM: AWS Bedrock only (short-lived STS credentials in VM metadata)
- API-mediated (callback to API via ILB): wiki tools, Brave Search (VM calls `/api/internal/agents/:agentId/*`, API proxies with its own keys, per-agent rate limits). See section 10.6.
- No direct access: Postgres (Cloud SQL), BookStack admin API. VMs have no credentials or firewall path to these services.

## 7. Security boundaries (current state)

Current trust boundary:
- Untrusted tool execution (`bash`, `read`, `write`, `edit`) runs in the **same runtime trust domain** as the API process, host storage, and network namespace.

Current controls:
- Workspace path traversal checks in workspace route and tool helpers
- Skill package install path validation
- `file://` output sanitization to existing workspace files
- Multer upload limits (10MB/file, 20 files/request, 50MB workspace)

Current gaps:
- No kernel-level sandbox boundary for tool execution
- In-memory runtime/session coupling in API pods
- Workspace data tied to host FS semantics
- Session store is in-memory only (no shared session backend yet)
- Agent can access host env vars (API keys, DB credentials)
- Agent can access host network (internal services, other agents' workspaces)

## 8. Target architecture: GCE VM sandboxes

### 8.1 Overview

Each agent gets a dedicated GCE VM with two disks: an ephemeral boot disk (from golden image) and a persistent data disk (workspace). The VM runs a sandbox-server (Node.js HTTP) that wraps pi-coding-agent. The API server on GKE communicates with VMs via internal VPC networking.

**Two-disk model**: The boot disk contains the OS, Node, Python, and sandbox-server. It is created from a golden image and is disposable. The data disk (`workspace-<agentId>`) is a separate persistent disk mounted at `/workspace`. It survives VM deletion and can be detached and reattached to a different VM — this enables GPU upgrades without losing workspace state.

```text
┌──────────────────────────────────────────────┐
│ GCE VM: sandbox-<agentId>                    │
│ Machine type: e2-medium (CPU, default)       │
│   or n1-standard-4 + T4 (GPU, on-demand)    │
│                                              │
│ Boot disk: 10GB (from golden image,          │
│   ephemeral, recreated on VM swap)           │
│ Data disk: workspace-<agentId>, 20-50GB      │
│   (persistent, mounted at /workspace)        │
│                                              │
│ sandbox-server (Node.js, port 8888)          │
│ ├── POST /chat { sessionId, message, ... }   │
│ │   -> get or create pi-agent session        │
│ │   -> stream SSE events back                │
│ ├── GET /status                              │
│ │   -> { busy, activeSessions, gpuNeeded }   │
│ ├── GET /health                              │
│ ├── POST /upgrade (request GPU)              │
│ ├── GET /files                               │
│ ├── GET /file?path=...                       │
│ ├── POST /upload                             │
│ └── DELETE /file?path=...                    │
│                                              │
│ pi-agent sessions (Map<sessionId, session>)  │
│ ├── session A: user1, conversation 1         │
│ ├── session B: user1, conversation 2         │
│ └── session C: user2, conversation 3         │
│                                              │
│ GPU tracking: gpuSessions (Set<sessionId>)   │
│                                              │
│ /workspace (data disk, persistent)           │
│ ├── files created by all conversations       │
│ └── skills/<skill-name-id>/ (injected)       │
│                                              │
│ Pre-installed (boot disk):                   │
│   node, python3, pip, pandoc, git, curl,     │
│   build-essential, texlive                   │
│ GPU image also: nvidia-driver-535, CUDA      │
└──────────────────────────────────────────────┘
```

### 8.2 VM lifecycle

```text
User creates agent
  1. API inserts agent into Postgres (vm_status='creating', machine_type='e2-medium')
     All agents start on CPU regardless of intended workload.
  2. API creates persistent data disk: workspace-<agentId> (20GB pd-ssd)
  3. API increments vm_token_generation (new lifecycle epoch)
  4. API creates CPU VM from base image, attaches data disk at /workspace.
     VM metadata includes token minted with the NEW generation (post-increment).
  5. VM boots, startup script mounts data disk, launches sandbox-server (~20s)
  6. API polls VM:8888/health until ready
  7. API updates agent: vm_status='running', vm_ip=<IP>, data_disk_name=<name>
  8. Frontend shows agent as ready

User navigates to agent page
  1. Frontend: POST /api/sandbox/:agentId/ensure
  2. API checks vm_status:
     - 'running': return immediately (VM already on)
     - 'stopped': increment vm_token_generation, start VM (~5-10s for suspended CPU), inject new token via metadata update, show spinner
     - 'creating': wait for creation to finish
  3. Frontend loads chat history from Postgres immediately (no VM needed)
  4. By the time user reads history and starts typing, VM is ready

User chats (multiple users, multiple concurrent conversations)
  1. Browser: POST /api/agent-chat/:agentId/chat { message, sessionId }
  2. API checks agent_access: user has 'owner' or 'editor' role
  3. API saves user message to Postgres (with user_id)
  4. API forwards to VM:8888/chat { sessionId, message, systemPrompt, ... }
  5. Sandbox-server finds or creates pi-agent session for this sessionId
  6. Pi-agent runs, streams SSE events back
  7. API pipes SSE to browser, tracks segments/tool_calls
  8. API saves assistant message to Postgres
  9. API updates agent.last_activity_at
  10. For shared sessions: API broadcasts incoming events to all connected
      SSE clients on the same sessionId

Agent requests GPU (see section 8.9 for full flow)
  1. Agent calls request_gpu tool during a conversation
  2. Sandbox-server sends SSE event { type: 'gpu_request', ... } to browser
  3. User approves -> API orchestrates VM swap (CPU -> GPU, ~30-40s)
  4. Data disk detaches from CPU VM, attaches to new GPU VM
  5. Agent resumes on GPU VM with /workspace intact

No user activity for 15min (CPU) / 60min (GPU):
  1. Idle monitor checks: any session still streaming? (GET VM:8888/status)
     - busy=true: agent is working, reset idle timer, do not shut down
     - busy=false: safe to shut down
  2. Also checks gpuNeeded: if false and currently on GPU VM, downgrade to CPU first
  3. API increments vm_token_generation (revokes all outstanding VM JWTs before stop)
  4. CPU VMs: suspend (RAM saved to disk, ~5-10s resume, ~$0.01/day)
  5. GPU VMs: stop (RAM lost, data disk preserved, ~20s restart, ~$0.01/day)
  6. API updates agent: vm_status='stopped', vm_ip=null

User returns after idle:
  1. POST /api/sandbox/:agentId/ensure
  2. Always resumes as CPU VM (GPU is only active on-demand)
  3. CPU VM: resume from suspend (~5-10s), all sessions intact
  4. Data disk has all files, installed packages, pip venvs, etc.

User deletes agent:
  1. API calls GCE API: delete VM
  2. API calls GCE API: delete data disk (workspace-<agentId>)
  3. API deletes agent from Postgres (cascade deletes sessions/messages/access)
```

### 8.3 Idle shutdown rules

| VM type | Idle timeout | Shutdown method | Resume time | Resume behavior |
|---------|-------------|----------------|-------------|-----------------|
| CPU (default) | 15 min | Suspend | ~5-10s | All sessions + RAM intact |
| GPU (on-demand) | 60 min | Stop + downgrade to CPU | ~30-40s | Data disk reattached to CPU VM, sessions re-created |

The idle monitor additionally checks the VM before shutdown:

```text
GET VM:8888/status -> { busy: true/false, activeSessions: N, gpuNeeded: true/false }

If busy=true:
  Agent is currently executing (streaming, running tools).
  Do NOT shut down. Reset idle timer.

If busy=false AND gpuNeeded=true:
  No active work but a session still claims GPU.
  Apply GPU idle timeout (60 min). Do not downgrade yet.

If busy=false AND gpuNeeded=false AND currently on GPU:
  No sessions need GPU. Downgrade to CPU VM immediately
  (saves cost without waiting for full idle timeout).

If busy=false AND gpuNeeded=false AND on CPU:
  Agent is idle. Safe to suspend after CPU idle timeout (15 min).
```

This prevents shutting down a VM while the agent is in the middle of a long-running task (e.g., ML training, multi-step research). It also ensures GPU VMs are downgraded to CPU as soon as no session needs the GPU.

### 8.4 Sandbox-server specification

The sandbox-server is a Node.js HTTP server that wraps pi-coding-agent inside the VM. It supports multiple concurrent conversations.

New file: `sandbox/sandbox-server.ts`

```typescript
// Responsibilities:
// 1. Maintain a Map<sessionId, PiAgentSession> for concurrent conversations
// 2. Accept POST /chat with { sessionId, message, systemPrompt, skills, chatHistory }
//    - Get or create pi-agent session for this sessionId
//    - Stream SSE events back (same protocol as current stream.ts)
// 3. Expose GET /status { busy, activeSessions } for idle monitor
// 4. Expose GET /health for startup probe
// 5. Expose file operations for workspace access from API

// HTTP API contract:
//
// POST /chat
//   Request body: {
//     sessionId: string,              -- unique per conversation
//     message: string,
//     systemPrompt: string,
//     skills: Array<{ name, whenToUse, instructions, installPath, skillMarkdown }>,
//     chatHistory: Array<{ role, content }>,
//     outputFolder?: string,
//     model?: string
//   }
//
//   CONCURRENCY: Only one turn per sessionId at a time. If a POST /chat
//   arrives while a previous request for the same sessionId is still
//   streaming, the sandbox-server returns HTTP 409 Conflict immediately
//   (no queuing). The API surfaces this as a user-visible error:
//   "Agent is busy in this conversation. Wait for the current response."
//   The frontend disables the send button while an SSE stream is open.
//
//   Implementation in sandbox-server:
//     const activeTurns = new Set<string>();  // sessionIds with active streams
//     app.post('/chat', (req, res) => {
//       if (activeTurns.has(req.body.sessionId)) {
//         return res.status(409).json({ error: 'Turn in progress' });
//       }
//       activeTurns.add(req.body.sessionId);
//       // ... stream SSE ...
//       req.on('close', () => activeTurns.delete(req.body.sessionId));
//       // also delete on 'done' event
//     });
//
//   For shared sessions: User A sends a message, User B sees the agent
//   streaming. If User B tries to send before the agent finishes, the
//   API rejects with 409. This is intentional — shared sessions are
//   turn-based, not concurrent.
//
//   Response: SSE stream. Canonical event schema (v2):
//
//   --- Agent conversation events (from pi-coding-agent) ---
//     { type: 'session', sessionId }
//     { type: 'text', data: { mode: 'replace', text, blockIndex } }
//     { type: 'thinking', data: { mode: 'replace', text, blockIndex } }
//     { type: 'tool_call', data: { name, args } }
//     { type: 'tool_result', data: { name, result, error } }
//     { type: 'error', data: string }
//     { type: 'done' }
//
//   --- VM lifecycle events (new in v2) ---
//     { type: 'gpu_request', data: { reason, gpuType, estimatedMinutes, estimatedCost } }
//     { type: 'gpu_approved', data: {} }          -- sent after VM swap completes
//     { type: 'gpu_denied', data: { reason } }
//     { type: 'gpu_released', data: {} }           -- agent released GPU
//     { type: 'vm_upgrading', data: {} }            -- VM swap in progress
//
//   --- Shared-session events (new in v2) ---
//     { type: 'user_message', data: { userId, userName, content } }
//
//   All events are JSON-encoded in `data:` SSE frames.
//   Frontend must handle unknown event types gracefully (ignore them).
//   The v1 event types (session through done) are unchanged.
//
// GET /status
//   Response: { busy: bool, activeSessions: number, gpuNeeded: bool }
//   busy = true if ANY session is currently streaming
//   gpuNeeded = true if ANY session has requested GPU (gpuSessions.size > 0)
//
// GET /health
//   Response: { status: 'ok' }
//
// GET /files
//   Response: { files: Array<{ name, path, type, size, modified }> }
//
// GET /file?path=<relative>&raw=true&download=true
//   Response: file contents (text JSON or raw binary)
//
// POST /upload
//   multipart/form-data, field "file", query param "path"
//   Response: { path, size }
//
// DELETE /file?path=<relative>
//   Response: { deleted: true }
```

### 8.5 VM base images

Two golden images (CPU and GPU) with all dependencies pre-installed. Boot disks are small (10GB) since workspace data lives on the separate data disk.

```bash
# Create CPU base VM, install everything, save as image
gcloud compute instances create sandbox-base-cpu \
  --machine-type=e2-medium \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=10GB \
  --zone=us-central1-a

# SSH in and install:
# - Node.js 20 (via nodesource)
# - Python 3, pip, venv
# - pandoc, texlive-latex-base, texlive-fonts-recommended, texlive-latex-extra
# - git, curl, wget, build-essential
# - sandbox-server package (npm install to /opt/sandbox)

# Save CPU image
gcloud compute instances stop sandbox-base-cpu --zone=us-central1-a
gcloud compute images create sandbox-base-cpu \
  --source-disk=sandbox-base-cpu \
  --source-disk-zone=us-central1-a

# Create GPU base VM with GPU, also install:
# - nvidia-driver-535, nvidia-cuda-toolkit
# Save as sandbox-base-gpu (also 10GB boot, GPU drivers add ~2GB)
gcloud compute images create sandbox-base-gpu \
  --source-disk=sandbox-base-gpu \
  --source-disk-zone=us-central1-a

# Clean up
gcloud compute instances delete sandbox-base-cpu sandbox-base-gpu --zone=us-central1-a
```

The startup script reads metadata, mounts the data disk, and launches sandbox-server. See section 10.6.5 for the full script.

### 8.6 Sandbox-server session management

Multiple concurrent conversations share the same VM:

```typescript
// Inside sandbox-server
const sessions = new Map<string, PiAgentSession>();
const gpuSessions = new Set<string>(); // sessionIds that have requested GPU

app.post('/chat', async (req, res) => {
  const { sessionId, message, systemPrompt, skills, chatHistory } = req.body;

  let session = sessions.get(sessionId);
  if (!session) {
    // Create new pi-agent session for this conversation
    // Same logic as current getPiSession() in session.ts
    // but keyed by sessionId, workspace at /workspace
    session = await createSession(systemPrompt, skills, chatHistory);
    sessions.set(sessionId, session);
  }

  // Stream SSE events (same as current streamPiAgent())
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  for await (const event of streamPiAgent(session, message)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});

app.get('/status', (req, res) => {
  const busy = [...sessions.values()].some(s => s.isStreaming);
  res.json({
    busy,
    activeSessions: sessions.size,
    gpuNeeded: gpuSessions.size > 0
  });
});

// Called by request_gpu tool handler when agent requests GPU
function markGpuNeeded(sessionId: string) {
  gpuSessions.add(sessionId);
}

// Called by release_gpu tool handler or when session ends
function markGpuReleased(sessionId: string) {
  gpuSessions.delete(sessionId);
}
```

All conversations share the same `/workspace` filesystem. Like having multiple terminal tabs on the same machine.

**Resource isolation between sessions**: Multiple pi-agent sessions share one VM with no kernel-level isolation between them. One runaway process (infinite loop, OOM) can affect all conversations for that agent.

Mitigations built into the sandbox-server:
- **Max concurrent sessions**: configurable limit (default: 5). Reject new `/chat` requests with HTTP 429 when at capacity.
- **Per-session process group**: each `bash` tool invocation runs in a new process group. The sandbox-server tracks child PIDs per session and kills the group on session abort.
- **Agent runtime timeout**: `MAX_AGENT_RUNTIME_MS` (default 5 hours, from current `stream.ts`) applies per streaming request. Runaway sessions are force-terminated.
- **VM-level OOM**: GCE VMs have fixed RAM per machine type. The OS OOM killer handles memory exhaustion. This is acceptable because the blast radius is one agent (one user), not the platform.
- **Disk quota**: workspace size checked on upload (50MB default). Bash-created files can exceed this — monitor via periodic `du` check in sandbox-server, warn but don't hard-kill.

This is an explicit trade-off: sessions within one agent VM are cooperative, not isolated. If stronger per-session isolation is needed later, each conversation could get its own VM (at higher cost).

### 8.7 Pre-boot on page navigation

To hide VM startup latency, the frontend triggers VM startup the moment the user opens an agent page — before they send any message:

```typescript
// Frontend: AgentsPage, when agent is selected
useEffect(() => {
  const ensureVM = async () => {
    setVmStarting(true);
    await fetch(`/api/sandbox/${agentId}/ensure`, { method: 'POST' });
    setVmStarting(false);
  };
  ensureVM();

  // Heartbeat while page is visible (resets idle timer)
  const interval = setInterval(() => {
    if (!document.hidden) {
      fetch(`/api/sandbox/${agentId}/heartbeat`, { method: 'POST' });
    }
  }, 60_000);

  return () => clearInterval(interval);
}, [agentId]);
```

The frontend loads chat history from Postgres immediately (no VM needed). By the time the user reads history and types a message, the VM is usually ready.

| Scenario | Perceived wait |
|----------|---------------|
| VM already running (CPU or GPU) | 0s |
| CPU VM suspended | 5-10s (hidden behind page load) |
| First-ever creation | ~20s (show progress spinner) |
| GPU upgrade (user approved) | ~30-40s (show progress spinner) |

### 8.8 Security model (target)

**What this architecture provides is blast-radius partitioning, not secure code execution containment.** The agent has full root-level access inside its VM and can do anything the VM OS permits. The security boundary is between the VM and everything else — not between the agent and the VM internals.

Isolation guarantees:
- **VM-level isolation**: each agent runs in its own GCE VM. Separate kernel, separate network stack, separate disk. No container escape vector because there is no shared kernel.
- **VPC firewall**: sandbox VMs accept inbound traffic only from GKE pod CIDR on port 8888. No inbound from internet.
- **No access to control plane data**: VMs have no DATABASE_URL, no BookStack admin tokens, no vendor API keys. Cloud SQL access is blocked by explicit DENY egress rule (priority 500). API callbacks go through ILB with per-VM JWT auth. VMs use a dedicated minimal SA (`sandbox-vm@`) with only logging/monitoring write permissions — no storage, compute, or IAM access.
- **Per-agent blast radius**: a compromised or misbehaving agent can only damage its own VM and workspace. It cannot affect other agents, the API, or the database.
- **Persistent data disk per agent**: workspace data is isolated per agent on a dedicated disk that survives VM swaps. No shared filesystems.
- **No vendor API keys on VMs**: Brave Search and Gemini API keys are held only by the API and proxied through `/api/internal/*` endpoints with per-agent rate limits. Only short-lived AWS STS credentials (1h) exist on VMs for Bedrock access.
- **Network egress**: VMs have outbound HTTPS for Bedrock and general internet (pip install, git clone). A malicious agent can exfiltrate data from its own workspace to the internet. To mitigate: restrict egress to known CIDR blocks via firewall rules (see section 10.5).

What this architecture does NOT provide:
- **Containment of agent actions within the VM**: the agent can read all VM metadata, install packages, run servers, modify system files, and make arbitrary outbound network calls.
- **Protection of Bedrock credentials from the agent**: Bedrock STS credentials are in VM metadata and readable by agent code. Mitigated with mandatory 1h expiry + scoped IAM role (see section 10.6). Brave/Gemini keys are proxied through API and never enter the VM.
- **Isolation between conversations**: multiple sessions on the same VM share the same OS. One session can see/modify files created by another. This is by design (shared workspace).

### 8.9 Dynamic GPU activation

Agents always start on CPU VMs. GPU is activated on-demand when the agent determines it needs one.

**`request_gpu` tool definition** (available to all agents):

```typescript
{
  name: 'request_gpu',
  description: 'Request GPU access for compute-intensive tasks like ML training, '
    + 'large model inference, or CUDA-accelerated processing. The user must approve. '
    + 'The VM will restart with a GPU attached (~30-40s transition). '
    + 'All workspace files are preserved.',
  parameters: {
    reason: { type: 'string', description: 'Why GPU is needed' },
    gpuType: {
      type: 'string',
      enum: ['nvidia-tesla-t4', 'nvidia-l4'],
      default: 'nvidia-tesla-t4',
      description: 'GPU model to request'
    },
    estimatedMinutes: {
      type: 'number',
      description: 'Estimated GPU usage time in minutes'
    }
  }
}
```

**`release_gpu` tool definition**:

```typescript
{
  name: 'release_gpu',
  description: 'Release GPU access after compute-intensive work is complete. '
    + 'VM will switch back to CPU-only (~30-40s transition) to save cost. '
    + 'All workspace files are preserved.',
  parameters: {}
}
```

**Full GPU upgrade flow**:

```text
1. Agent calls request_gpu({ reason: "Train BERT model", estimatedMinutes: 120 })

2. Sandbox-server handles the tool call:
   a. Marks sessionId in gpuSessions set
   b. Sends SSE event to browser (via the streaming response):
      { type: 'gpu_request', data: {
          reason: 'Train BERT model',
          gpuType: 'nvidia-tesla-t4',
          estimatedMinutes: 120,
          estimatedCost: '$1.20'
      }}
   c. Blocks the tool call, waiting for approval callback

3. Browser shows approval UI:
   "Agent requests GPU access: Train BERT model (~2h, ~$1.20)
    [Approve] [Deny]"

4a. User clicks Approve:
    Browser: POST /api/sandbox/:agentId/gpu/approve
    API orchestrates the swap:
      i.   Increment vm_token_generation (revokes all CPU VM tokens immediately)
      ii.  Set vm_status='upgrading'
      iii. Stop current CPU VM
      iv.  Detach data disk (workspace-<agentId>) from CPU VM
      v.   Delete CPU VM
      vi.  Create GPU VM (n1-standard-4 + T4) from GPU base image.
           VM metadata includes token minted with the current (post-increment) generation.
      vii. Attach data disk to GPU VM
      viii. Start GPU VM, wait for health check (~30-40s total)
      ix.  Update agent: vm_status='running', gpu_active=true, vm_ip=<new IP>
    API: POST new-VM:8888/gpu-approved { sessionId }
    Sandbox-server: unblocks the request_gpu tool call, returns { approved: true }
    Agent continues execution, now with GPU access.

4b. User clicks Deny:
    Browser: POST /api/sandbox/:agentId/gpu/deny
    API: POST VM:8888/gpu-denied { sessionId }
    Sandbox-server: unblocks the tool call, returns { approved: false, reason: 'User denied' }
    Agent adapts (e.g., uses CPU-only approach, reduces batch size, etc.)

5. Agent finishes GPU work, calls release_gpu()
   Sandbox-server: removes sessionId from gpuSessions
   If gpuSessions.size === 0:
     API detects via /status { gpuNeeded: false }
     API orchestrates reverse swap:
       i.   Increment vm_token_generation (revokes all GPU VM tokens immediately)
       ii.  Stop GPU VM
       iii. Detach data disk
       iv.  Delete GPU VM
       v.   Create CPU VM from CPU base image.
            VM metadata includes token minted with the current (post-increment) generation.
       vi.  Attach data disk
       vii. Start CPU VM (~30-40s total)
       viii. Update agent: gpu_active=false, vm_ip=<new IP>

6. Alternative: idle monitor detects gpuNeeded=false on next check
   and triggers the same downgrade automatically.
```

**Session continuity during VM swap**: When the VM is swapped, all in-memory pi-agent sessions are lost. The sandbox-server on the new VM recreates sessions from Postgres chat history on the next message from each conversation. The tool call that triggered the swap (request_gpu/release_gpu) is the last thing in chat history, so the agent resumes with full context.

**Cost impact**: A user who runs a CPU agent for 8 hours but only needs GPU for 30 minutes pays for 7.5 hours of e2-medium (~$0.05) + 0.5 hours of n1-standard-4+T4 (~$0.40) = ~$0.45 instead of 8 hours of GPU (~$6.40). 93% savings.

### 8.10 Multi-user agent access

Multiple users can interact with the same agent. All users share the same VM and workspace.

**Access model**:
- Agent creator is automatically assigned `owner` role in `agent_access`
- Owners can share the agent with other users in their org (via agent settings UI)
- Each user gets their own conversations by default (private sessions)
- Users can also create shared sessions that multiple users can join

**Private conversations** (default):
- User creates a conversation (new `agent_chat_sessions` row with `created_by = userId`, `shared = false`)
- Only the creating user can see and interact with this conversation
- Multiple users can have concurrent private conversations on the same agent
- All conversations share `/workspace` — files created in one conversation are visible in another

**Shared conversations**:
- Any editor/owner creates a shared session (`shared = true`)
- Other users with access can join the session
- Messages from all participants are interleaved in the same chat history (each with `user_id`)
- All connected browsers receive SSE events in real-time
- Implementation: Redis pub/sub for cross-pod broadcast. The API runs on 2+ replicas, so in-memory maps only see local connections. Redis channels ensure all replicas receive events.

```typescript
// API-side: shared session SSE broadcast via Redis pub/sub
import Redis from 'ioredis';
const redisPub = new Redis(process.env.REDIS_URL);
const redisSub = new Redis(process.env.REDIS_URL);

// Per-pod local map of SSE connections
const localClients = new Map<string, Set<Response>>();

// Subscribe to shared session channels
redisSub.on('message', (channel, message) => {
  // channel = 'session:<sessionId>'
  const sessionId = channel.replace('session:', '');
  for (const client of localClients.get(sessionId) ?? []) {
    client.write(`data: ${message}\n\n`);
  }
});

// When a client connects to a shared session on this pod:
function addClient(sessionId: string, res: Response) {
  if (!localClients.has(sessionId)) {
    localClients.set(sessionId, new Set());
    redisSub.subscribe(`session:${sessionId}`);
  }
  localClients.get(sessionId)!.add(res);

  // Clean up on disconnect (browser close, network drop, SSE timeout)
  res.on('close', () => removeClient(sessionId, res));
}

// Remove client and unsubscribe when no local listeners remain
function removeClient(sessionId: string, res: Response) {
  const clients = localClients.get(sessionId);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) {
    localClients.delete(sessionId);
    redisSub.unsubscribe(`session:${sessionId}`);
  }
}

// When an event arrives from the VM (on whichever pod proxied the chat):
function broadcastEvent(sessionId: string, event: any) {
  redisPub.publish(`session:${sessionId}`, JSON.stringify(event));
}
```

**Redis instance**: Use GCP Memorystore for Redis (managed). Minimal spec: 1GB Basic tier (~$30/mo). Used only for pub/sub (no persistence needed). Add to GCP infrastructure (section 10).

**Frontend changes for multi-user**:
- Agent settings page: share agent with users (search by name/email within org)
- Session list: shows "Private" or "Shared" badge, shows participant avatars for shared
- Shared sessions: show which user sent each message (user name/avatar next to message)
- Real-time presence: show who is currently viewing the agent (WebSocket or SSE heartbeat)

## 9. API code changes for VM integration

### 9.1 New module: `src/services/sandbox/gce.ts`

GCE VM lifecycle management using `@google-cloud/compute`:

```typescript
// Key functions:
//
// createDataDisk(agentId, sizeGb)
//   -> Creates persistent disk: workspace-<agentId>
//
// createVM(agentId, machineType, gpuType?)
//   -> Creates GCE VM from base image (CPU or GPU)
//   -> Attaches data disk (workspace-<agentId>)
//   -> Returns when health check passes
//
// startVM(agentId)
//   -> Starts a stopped VM, or resumes a suspended VM
//   -> Waits for health check, returns VM IP
//
// stopVM(agentId, gpuActive)
//   -> CPU: suspendVM (RAM preserved, fast resume)
//   -> GPU: stopVM (RAM lost, data disk preserved)
//
// upgradeToGpu(agentId, gpuType)
//   -> Stops CPU VM, detaches data disk, deletes CPU VM
//   -> Creates GPU VM, attaches data disk, starts
//   -> Returns new VM IP
//
// downgradeToCpu(agentId)
//   -> Stops GPU VM, detaches data disk, deletes GPU VM
//   -> Creates CPU VM, attaches data disk, starts
//   -> Returns new VM IP
//
// deleteVM(agentId)
//   -> Deletes VM instance (not data disk)
//
// deleteDataDisk(agentId)
//   -> Deletes persistent data disk
//
// getVMStatus(agentId) -> 'RUNNING' | 'STOPPED' | 'SUSPENDED' | 'NONE'
//
// getVMIP(agentId) -> string
```

### 9.2 New module: `src/services/sandbox/client.ts`

Abstraction layer that works in both local dev and production:

```typescript
// SandboxClient with mode switching:
//
// SANDBOX_MODE=local  -> sandbox-server at localhost:8888
// SANDBOX_MODE=gce    -> sandbox-server at VM internal IP:8888
//
// Key methods:
//
// ensure(agentId)        -> ensure VM is running, return { url, status }
// heartbeat(agentId)     -> update last_activity_at
// chatStream(agentId, sessionId, request) -> pipe SSE from VM
// listFiles(agentId)     -> GET VM:8888/files
// readFile(agentId, path) -> GET VM:8888/file?path=...
// uploadFile(agentId, path, data) -> POST VM:8888/upload
// deleteFile(agentId, path) -> DELETE VM:8888/file?path=...
// status(agentId)        -> GET VM:8888/status { busy, activeSessions, gpuNeeded }
// approveGpu(agentId, sessionId) -> orchestrate CPU->GPU swap via gce.upgradeToGpu()
// denyGpu(agentId, sessionId)    -> POST VM:8888/gpu-denied
// downgradeGpu(agentId)          -> orchestrate GPU->CPU swap via gce.downgradeToCpu()
```

### 9.3 New route: `src/routes/sandbox.ts`

**Per-agent lifecycle lock**: VM lifecycle operations (ensure, GPU approve, idle shutdown) must be serialized per agent to prevent races when multiple API replicas handle concurrent requests. Use Postgres advisory locks keyed by agent ID:

```typescript
import { PoolClient } from 'pg';

// Acquire per-agent advisory lock. The locked client is passed into fn()
// so all DB work runs on the SAME connection — no extra pool pressure.
async function withAgentLock<T>(agentId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await vmInternalPool.connect();
  try {
    await client.query('BEGIN');
    // Two-key advisory lock from UUID: deterministic, very low collision risk.
    // UUID has 32 hex chars (after removing hyphens). Split into two 8-char halves,
    // convert each to int4 via hex decode. This maps 64 bits of the UUID prefix
    // into the two-int key space of pg_advisory_xact_lock(key1, key2).
    // Note: uses 64 of 128 UUID bits. Collision probability is ~1/2^64 per pair,
    // negligible for expected agent counts, but not mathematically impossible.
    const hex = agentId.replace(/-/g, '');  // e.g., 'a1b2c3d4e5f6a7b8...' (32 chars)
    await client.query(
      "SELECT pg_advisory_xact_lock(('x' || $1)::bit(32)::int, ('x' || $2)::bit(32)::int)",
      [hex.substring(0, 8), hex.substring(8, 16)]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Usage in ensure — all queries use the locked client, not vmInternalQuery():
app.post('/api/sandbox/:agentId/ensure', async (req, res) => {
  const result = await withAgentLock(req.params.agentId, async (client) => {
    const agent = await client.query(
      'SELECT vm_status, vm_ip FROM agents WHERE id = $1',
      [req.params.agentId]
    );
    if (agent.rows[0].vm_status === 'running') {
      return { status: 'ready', vmIp: agent.rows[0].vm_ip };
    }
    // Only one pod can start the VM — others block on the lock
    await gce.startVM(req.params.agentId);
    await client.query(
      "UPDATE agents SET vm_status = 'starting' WHERE id = $1",
      [req.params.agentId]
    );
    return { status: 'starting' };
  });
  res.json(result);
});
```

This prevents: two pods both calling `gce.createVM()` for the same agent, two GPU approvals racing, or an idle-shutdown overlapping with an ensure. The lock is per-agent (not global), so operations on different agents proceed in parallel.

```typescript
// POST /api/sandbox/:agentId/ensure
//   Acquires per-agent lock, then ensures VM is running. Creates or starts if needed.
//   Returns: { status: 'ready' | 'starting', vmIp, gpuActive: bool }
//
// POST /api/sandbox/:agentId/heartbeat
//   Updates last_activity_at. No lock needed (idempotent UPDATE).
//   Returns: { ok: true }
//
// POST /api/sandbox/:agentId/release
//   Optional explicit release. Starts idle timer immediately.
//   Returns: { ok: true }
//
// POST /api/sandbox/:agentId/gpu/approve
//   Acquires per-agent lock. Triggers CPU->GPU VM swap.
//   Returns: { status: 'upgrading' } immediately, frontend polls until 'running'
//
// POST /api/sandbox/:agentId/gpu/deny
//   User denies GPU request. Notifies sandbox-server.
//   Returns: { ok: true }
```

### 9.4 Modified: `src/routes/agent-chat.ts`

The chat route changes from "run pi-agent in-process" to "proxy to VM":

```typescript
// Current flow (REMOVE):
//   const { session } = await getPiSession(agentId, systemPrompt, customTools, chatHistory);
//   for await (const event of streamPiAgent(session, message, systemPrompt)) { ... }
//
// New flow:
//   const client = new SandboxClient();
//   const { status } = await client.ensure(agentId);
//   if (status === 'starting') {
//     return res.status(503).json({
//       error: 'vm_starting',
//       message: 'Agent VM is starting up. Retry in a few seconds.',
//       retryAfterMs: 5000
//     });
//   }
//   for await (const event of client.chatStream(agentId, sessionId, {
//     message, systemPrompt, skills, chatHistory, outputFolder
//   })) {
//     res.write(`data: ${JSON.stringify(event)}\n\n`);
//     handleEvent(event);
//   }
//
// The v1 SSE events (session, text, thinking, tool_call, tool_result, error, done)
// are unchanged — existing chat rendering works without modification.
// v2 events (gpu_request, user_message, vm_upgrading) require new frontend handlers
// (see section 9.11). Frontend must ignore unknown event types gracefully.
// VM readiness is enforced server-side; routes do not depend on frontend
// having called /ensure first.
```

### 9.5 Modified: `src/routes/workspace.ts`

Workspace file operations proxy to the VM instead of reading host filesystem:

```typescript
// Current flow (REMOVE):
//   const workspaceDir = getWorkspaceDir(agentId);
//   const files = await buildFileTree(workspaceDir);
//
// New flow:
//   const client = new SandboxClient();
//   const files = await client.listFiles(agentId);
//   // Same response shape -- frontend doesn't change
//
// VM readiness enforcement:
// Every workspace endpoint must check VM status before proxying.
// Do NOT rely on the frontend having called /ensure first.
//
//   const { url, status } = await client.ensure(agentId);
//   if (status === 'starting') {
//     return res.status(503).json({
//       error: 'vm_starting',
//       message: 'Agent VM is starting up. Retry in a few seconds.',
//       retryAfterMs: 5000
//     });
//   }
//   // VM is running — proxy the request
//
// This makes workspace routes self-contained: they work correctly
// for non-UI clients, API scripts, and race conditions where the
// frontend /ensure hasn't completed yet.
```

### 9.6 Modified: `src/routes/agents.ts`

Agent CRUD now includes VM lifecycle:

```typescript
// POST /api/agents (create)
//   1. Insert into Postgres with org_id, machine_type='e2-medium' (always CPU)
//   2. Insert agent_access row: { agent_id, user_id: req.user.id, role: 'owner' }
//   3. Call gce.createDataDisk(agentId, 20) -- 20GB persistent disk
//   4. Call gce.createVM(agentId, 'e2-medium') -- CPU VM, attach data disk
//   5. Return agent with vm_status='creating'
//   6. Frontend polls until vm_status='running'
//
// DELETE /api/agents/:id
//   1. Verify req.user has 'owner' role in agent_access
//   2. Increment vm_token_generation (revokes any outstanding VM tokens)
//   3. Call gce.deleteVM(agentId)
//   4. Call gce.deleteDataDisk(agentId)
//   5. Delete from Postgres (cascade deletes access, sessions, messages)
//
// POST /api/agents/:id/share
//   1. Verify req.user has 'owner' role
//   2. Insert/update agent_access: { agent_id, user_id, role }
//   3. Target user must be in same org
//
// DELETE /api/agents/:id/share/:userId
//   1. Verify req.user has 'owner' role
//   2. Delete agent_access row (cannot remove own owner access)
```

### 9.7 New module: `src/services/sandbox/idle-monitor.ts`

Background loop that checks for idle VMs and shuts them down:

```typescript
// Runs every IDLE_CHECK_INTERVAL_MS (60000)
//
// For each agent WHERE vm_status = 'running'
//   AND last_activity_at < NOW() - IDLE_TIMEOUT:
//
//   1. GET VM:8888/status -> { busy, activeSessions, gpuNeeded }
//   2. If busy=true: reset last_activity_at, skip
//   3. If busy=false AND gpu_active=true AND gpuNeeded=false:
//      -> Increment vm_token_generation (revokes GPU VM tokens immediately)
//      -> Downgrade to CPU (gce.downgradeToCpu — new CPU VM token uses post-increment generation)
//      -> Update agent: gpu_active=false, vm_ip=<new IP>
//      -> Reset idle timer (don't immediately suspend the new CPU VM)
//   4. If busy=false AND (not gpu_active OR gpuNeeded=false):
//      -> Increment vm_token_generation (revokes current VM tokens)
//      -> Shut down CPU VM: suspend (fast resume)
//      -> Update agent: vm_status='stopped', vm_ip=null
//   5. If busy=false AND gpu_active=true AND gpuNeeded=true:
//      -> GPU idle timeout (60 min) not yet reached: skip
//      -> GPU idle timeout reached: increment vm_token_generation, stop GPU VM
//      -> Update agent: vm_status='stopped', gpu_active=false, vm_ip=null
//
// CONCURRENCY: All VM-mutating operations (steps 3, 4, 5) acquire the
// per-agent advisory lock (withAgentLock) to prevent races with
// concurrent ensure/gpu-approve requests on other pods.
//
// LEADER ELECTION: Only one API pod should run the idle monitor loop.
// Use pg_try_advisory_lock(0) at loop start — if acquired, run checks;
// if not, another pod is already running the monitor. The lock is
// released at the end of each check cycle (not held permanently).
//
// IDLE_TIMEOUT:
//   - CPU VMs: 15 minutes
//   - GPU VMs (with gpuNeeded=true): 60 minutes
```

### 9.8 Relocated modules

These files move from the API package to the `sandbox/` package (they run inside the VM now):

- `src/services/pi-agent/session.ts` -> `sandbox/src/session.ts`
- `src/services/pi-agent/stream.ts` -> `sandbox/src/stream.ts`
- `src/services/pi-agent/tools.ts` -> `sandbox/src/tools.ts`

### 9.9 New route: `src/routes/auth.ts` (target state)

```typescript
// GET /api/auth/me
//   Returns current user: { id, orgId, email, name, role }
//   Populated from SSO session
//
// GET /api/auth/login
//   Redirects to CAS/SAML/OIDC provider
//
// GET /api/auth/callback
//   Handles SSO callback, creates/updates user + org in Postgres
//   Sets session cookie, redirects to frontend
```

**Session cookie requirements**:
- `HttpOnly`: true (prevents JavaScript access — mitigates XSS token theft)
- `Secure`: true (HTTPS only — required since `ai.mines.edu` is TLS-terminated at ingress)
- `SameSite`: `lax` (prevents CSRF on state-changing requests while allowing top-level navigations for SSO redirect flow)
- `Path`: `/api` (cookie not sent for static frontend assets)
- `Max-Age`: 8 hours (session duration — users re-authenticate daily)
- Session store: server-side (Redis/Memorystore via `connect-redis`), not client-side JWT cookies. Session ID in cookie maps to server-side session data. This ensures sessions can be revoked server-side (e.g., on password change or admin action).

**CSRF protection**: `SameSite=lax` is the primary CSRF defense. State-changing API routes (`POST`, `PUT`, `DELETE`) additionally require an `Origin` header matching `https://ai.mines.edu` (checked by Express middleware). This blocks cross-origin form submissions and AJAX from malicious sites.

**OIDC/SAML security requirements** (whichever SSO protocol is used):
- **State parameter** (OIDC) / **RelayState** (SAML): random, server-side verified. Prevents login CSRF where an attacker initiates an auth flow to bind their identity to a victim's session.
- **Nonce** (OIDC): random per-request, embedded in ID token and verified on callback. Prevents token replay.
- **ID token signature verification**: validate against IdP's published JWKS (OIDC) or X.509 cert (SAML). Do not skip signature verification even in dev.
- **Token expiry**: check `exp` claim on ID tokens. Do not accept expired tokens.
- **Issuer/audience validation**: ID token `iss` must match expected IdP, `aud` must match our client ID.

### 9.10 New route: `src/routes/internal.ts` (target state)

API-mediated tools — called by sandbox-server, not by browser:

```typescript
// --- Agent-scoped routes: /api/internal/agents/:agentId/... ---
// Auth: per-VM JWT (issued at VM creation, stored in VM metadata)
// Middleware: validateVMToken enforces agentId in token matches URL :agentId
//
// GET  /api/internal/agents/:agentId/wiki/search?q=<query>    — BookStack search
// GET  /api/internal/agents/:agentId/wiki/page/:id            — read wiki page
// GET  /api/internal/agents/:agentId/wiki/books               — list all books
// POST /api/internal/agents/:agentId/brave/search             — Brave Search proxy (rate-limited)
// POST /api/internal/agents/:agentId/refresh-credentials      — STS + JWT refresh
//
// --- Bootstrap route (not agent-scoped in URL) ---
// POST /api/internal/bootstrap-credentials                    — emergency re-auth via GCE instance identity token
//   Auth: GCE instance identity token (NOT VM JWT). Used when JWT has expired and cannot be refreshed.
//   agentId derived from verified instance name, not from URL parameter.
```

### 9.11 Frontend changes

VM lifecycle:
- Agent creation form: no machine type selector needed (all agents start on CPU)
- Agent page: show VM status indicator (running/starting/stopped/upgrading)
- Agent page: show spinner during VM startup with progress message
- Agent page: call `/api/sandbox/:agentId/ensure` on mount, heartbeat on interval
- Chat: support multiple conversations per agent (session selector/tabs)

GPU approval:
- Handle `gpu_request` SSE event: show approval dialog with reason, GPU type, estimated cost
- Approve/Deny buttons: POST to `/api/sandbox/:agentId/gpu/approve` or `/gpu/deny`
- Show "Upgrading to GPU..." progress during swap (~30-40s)
- Show GPU badge on agent when `gpu_active=true`

Multi-user:
- Agent settings page: share agent with org users (search by name/email)
- Agent settings: set role per user (owner/editor/viewer)
- Session list: show "Private" / "Shared" badge, participant avatars for shared sessions
- Shared sessions: show user name/avatar next to each message
- Real-time presence: show who is currently viewing the agent (SSE heartbeat)
- Create shared conversation button

Multi-tenancy:
- Org name displayed in top bar (users belong to exactly one org — no org switcher)
- All agent/skill lists filtered to current org via RLS
- No cross-org visibility

## 10. GCP infrastructure

### 10.1 GKE cluster (API + control plane only)

```bash
PROJECT_ID=mines-ai-project
REGION=us-central1
CLUSTER_NAME=mines-ai-cluster
VPC_NETWORK=mines-ai-vpc    # All resources must share the same VPC
VPC_SUBNET=mines-ai-subnet  # GKE, sandbox VMs, ILB, Cloud SQL, Memorystore

gcloud container clusters create-auto ${CLUSTER_NAME} \
  --location=${REGION} \
  --project=${PROJECT_ID} \
  --network=${VPC_NETWORK} \
  --subnetwork=${VPC_SUBNET}
```

**VPC requirement**: GKE cluster, sandbox VMs, ILB, Cloud SQL, and Memorystore must all be in the same VPC. Do not use the `default` VPC — create a dedicated VPC with a known subnet range:

```bash
gcloud compute networks create ${VPC_NETWORK} --subnet-mode=custom
gcloud compute networks subnets create ${VPC_SUBNET} \
  --network=${VPC_NETWORK} \
  --region=${REGION} \
  --range=10.0.0.0/20
```

Autopilot is fine here -- no sandboxing on K8s, just standard deployments. The cluster runs API, BookStack, and frontend. All sandbox work happens on GCE VMs.

### 10.2 Memorystore for Redis (shared session pub/sub)

```bash
gcloud redis instances create mines-ai-redis \
  --size=1 \
  --region=${REGION} \
  --tier=basic \
  --network=${VPC_NETWORK}
```

Used for shared-session SSE fanout across API replicas (pub/sub only, no data persistence). API pods connect via the Memorystore private IP.

### 10.3 Cloud SQL for PostgreSQL

Cloud SQL must be on the same VPC as GKE and sandbox VMs, with private IP only (no public IP). This requires Private Services Access on the VPC.

```bash
# Step 1: Enable Private Services Access (one-time per VPC)
gcloud compute addresses create google-managed-services-${VPC_NETWORK} \
  --global \
  --purpose=VPC_PEERING \
  --addresses=10.100.0.0 \
  --prefix-length=16 \
  --network=${VPC_NETWORK}

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-${VPC_NETWORK} \
  --network=${VPC_NETWORK}

# Step 2: Create Cloud SQL with private IP only
gcloud sql instances create mines-ai-db \
  --database-version=POSTGRES_16 \
  --tier=db-custom-2-8192 \
  --region=${REGION} \
  --database-flags=max_connections=200 \
  --storage-size=20GB \
  --storage-auto-increase \
  --network=${VPC_NETWORK} \
  --no-assign-ip

# Step 3: Create database
gcloud sql databases create mines_ai --instance=mines-ai-db
```

**`--no-assign-ip`** disables the public IP. Cloud SQL is reachable only via its VPC-peered private IP. Combined with the sandbox VM egress DENY rule (section 10.5), VMs cannot reach Cloud SQL even if they somehow obtained DATABASE_URL.

**DATABASE_URL** for the API uses the private IP: `postgresql://app_user:...@<CLOUD_SQL_PRIVATE_IP>:5432/mines_ai`.

### 10.4 GCE VM creation (reference)

VMs are created individually via `instances.insert()` because each agent gets unique metadata (agent ID, secrets) and an attached data disk. Templates are not used.

**Zone placement strategy**: Data disks are zonal, so once a disk is created the agent is pinned to that zone. The `gce.ts` module selects a zone at disk creation time from an ordered preference list and records it in `agents.vm_zone`:

```typescript
// Zone preference list (env var or hardcoded default). First zone is preferred;
// fallback zones used when preferred zone has capacity errors or GPU scarcity.
const ZONE_PREFERENCE = (process.env.GCE_ZONE_PREFERENCE || 'us-central1-a,us-central1-b,us-central1-f').split(',');

// On disk creation: try zones in order, record chosen zone in agents.vm_zone.
// On VM creation/GPU swap: always use the zone stored in agents.vm_zone (disk affinity).
```

After disk creation, all VM operations (create, GPU upgrade, stop, start) use the zone stored in `agents.vm_zone` to maintain disk affinity. If the preferred zone is unavailable at disk creation time, the next zone in the list is tried. GPU upgrades are constrained to the same zone as the data disk — if that zone has no GPU capacity, the upgrade fails with a clear error rather than silently creating in a different zone.

```bash
# Step 1: Create data disk (once per agent, persists across VM swaps)
# Zone selected from ZONE_PREFERENCE, stored in agents.vm_zone
gcloud compute disks create workspace-AGENT_ID \
  --size=20GB \
  --type=pd-ssd \
  --zone=${AGENT_ZONE}

# Step 2: Create CPU VM with data disk attached (same zone as disk)
gcloud compute instances create sandbox-AGENT_ID \
  --machine-type=e2-medium \
  --image=sandbox-base-cpu \
  --boot-disk-size=10GB \
  --boot-disk-type=pd-standard \
  --boot-disk-auto-delete \
  --disk=name=workspace-AGENT_ID,device-name=workspace,mode=rw,auto-delete=no \
  --metadata=agent-id=AGENT_ID,... \
  --metadata-from-file=startup-script=sandbox/startup.sh \
  --tags=sandbox-vm \
  --labels=org=mines,agent-id=AGENT_ID \
  --service-account=sandbox-vm@${PROJECT_ID}.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write \
  --network=${VPC_NETWORK} \
  --zone=${AGENT_ZONE}

# GPU upgrade: delete CPU VM (boot disk auto-deleted, data disk preserved),
# create GPU VM with same data disk attached (same zone — disk affinity):
gcloud compute instances create sandbox-AGENT_ID \
  --machine-type=n1-standard-4 \
  --accelerator=type=nvidia-tesla-t4,count=1 \
  --image=sandbox-base-gpu \
  --boot-disk-size=10GB \
  --boot-disk-type=pd-standard \
  --boot-disk-auto-delete \
  --disk=name=workspace-AGENT_ID,device-name=workspace,mode=rw,auto-delete=no \
  --maintenance-policy=TERMINATE \
  --metadata=agent-id=AGENT_ID,... \
  --metadata-from-file=startup-script=sandbox/startup-gpu.sh \
  --tags=sandbox-vm \
  --labels=org=mines,agent-id=AGENT_ID \
  --service-account=sandbox-vm@${PROJECT_ID}.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write \
  --network=${VPC_NETWORK} \
  --zone=${AGENT_ZONE}
```

**Sandbox VM service account**: A dedicated minimal SA (`sandbox-vm@`) with only `roles/logging.logWriter` and `roles/monitoring.metricWriter`. This replaces the default Compute Engine SA which has far too many permissions. Create it once:

```bash
gcloud iam service-accounts create sandbox-vm \
  --display-name="Sandbox VM (minimal)" \
  --project=${PROJECT_ID}

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member=serviceAccount:sandbox-vm@${PROJECT_ID}.iam.gserviceaccount.com \
  --role=roles/logging.logWriter

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member=serviceAccount:sandbox-vm@${PROJECT_ID}.iam.gserviceaccount.com \
  --role=roles/monitoring.metricWriter
```

**Why not `--no-service-account`**: Zero GCP identity means no structured logging or metrics from VMs. The minimal SA grants only log/metric writes — no storage, no compute, no IAM. Agent code can see this SA via the metadata server, but it can only write logs and metrics (which is desirable for observability, not a risk).

Key flags:
- `--boot-disk-auto-delete`: boot disk deleted when VM is deleted (ephemeral)
- `--auto-delete=no` on data disk: data disk survives VM deletion (enables GPU swap)
- `--labels=org=<slug>`: for per-org billing reports
- `--service-account=sandbox-vm@...`: dedicated minimal SA (logging + monitoring only)

### 10.5 VPC networking and firewall

**Design principles**:
- GKE Autopilot manages node tags internally. Do NOT use `--source-tags=gke-*`.
- Cloud SQL isolation requires explicit deny egress, not just "no allow rule."
- Sandbox->API callbacks use an Internal Load Balancer (ILB), not pod CIDR routing.

#### 10.5.1 Internal Load Balancer for API callbacks

Sandbox VMs need a stable endpoint to call back to the API for wiki/KB tool queries (see section 10.6). Pod CIDRs are not a stable service interface — pods scale, restart, and get new IPs.

Create a GKE Internal Load Balancer (ILB) Service:

```yaml
# k8s/api-internal-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-internal-svc
  namespace: mines-ai
  annotations:
    networking.gke.io/load-balancer-type: "Internal"
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
  - port: 3001
    targetPort: 3001
    protocol: TCP
```

This creates a stable internal IP (e.g., `10.128.0.50`) that routes to API pods. Sandbox VMs use this IP as `API_CALLBACK_URL`.

```bash
# After deploying, get the ILB IP:
ILB_IP=$(kubectl get svc api-internal-svc -n mines-ai -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
```

The ILB IP is injected into VM metadata at creation time as `api-callback-url`.

#### 10.5.2 Firewall rules

```bash
# 1. Get the GKE cluster's pod CIDR
GKE_POD_CIDR=$(gcloud container clusters describe ${CLUSTER_NAME} \
  --location=${REGION} --format='value(clusterIpv4Cidr)')

# 2. Get Cloud SQL private IP
CLOUDSQL_IP=$(gcloud sql instances describe mines-ai-db \
  --format='value(ipAddresses[0].ipAddress)')

# --- INGRESS RULES ---

# 3. Allow API pods to reach sandbox VMs on port 8888
gcloud compute firewall-rules create allow-api-to-sandbox \
  --allow=tcp:8888 \
  --source-ranges=${GKE_POD_CIDR} \
  --target-tags=sandbox-vm \
  --network=${VPC_NETWORK} \
  --description="GKE API pods -> sandbox VMs on port 8888"

# --- EGRESS RULES (explicit deny-then-allow model) ---

# 4. DENY ALL egress from sandbox VMs (baseline)
gcloud compute firewall-rules create deny-sandbox-egress-all \
  --action=DENY \
  --rules=all \
  --direction=EGRESS \
  --target-tags=sandbox-vm \
  --priority=1000 \
  --network=${VPC_NETWORK} \
  --description="Baseline: deny all egress from sandbox VMs"

# 5. DENY egress to Cloud SQL explicitly (belt-and-suspenders, higher priority)
gcloud compute firewall-rules create deny-sandbox-to-cloudsql \
  --action=DENY \
  --rules=tcp:5432 \
  --direction=EGRESS \
  --destination-ranges=${CLOUDSQL_IP}/32 \
  --target-tags=sandbox-vm \
  --priority=500 \
  --network=${VPC_NETWORK} \
  --description="Explicit deny: sandbox VMs cannot reach Cloud SQL"

# 6. ALLOW egress to ILB (API callbacks for wiki/KB tools)
gcloud compute firewall-rules create allow-sandbox-to-ilb \
  --action=ALLOW \
  --rules=tcp:3001 \
  --direction=EGRESS \
  --destination-ranges=${ILB_IP}/32 \
  --target-tags=sandbox-vm \
  --priority=900 \
  --network=${VPC_NETWORK} \
  --description="Sandbox VMs -> API ILB for internal tool callbacks"

# 7. ALLOW egress HTTPS (external APIs: Bedrock only; Brave/Gemini proxied through API)
# NOTE: This also allows agents to make arbitrary HTTPS calls (pip install, git clone,
# curl, etc.). If stricter egress control is needed, restrict --destination-ranges to
# AWS Bedrock CIDR blocks only and route all other HTTPS through the API proxy.
gcloud compute firewall-rules create allow-sandbox-https-egress \
  --action=ALLOW \
  --rules=tcp:443 \
  --direction=EGRESS \
  --target-tags=sandbox-vm \
  --priority=900 \
  --network=${VPC_NETWORK} \
  --description="Sandbox VMs -> external HTTPS (Bedrock, pip, git, etc.)"

# 8. ALLOW egress DNS (needed for hostname resolution)
gcloud compute firewall-rules create allow-sandbox-dns-egress \
  --action=ALLOW \
  --rules=udp:53,tcp:53 \
  --direction=EGRESS \
  --target-tags=sandbox-vm \
  --priority=900 \
  --network=${VPC_NETWORK} \
  --description="Sandbox VMs -> DNS resolution"

# 9. ALLOW egress to GCE metadata server (169.254.169.254)
gcloud compute firewall-rules create allow-sandbox-metadata-egress \
  --action=ALLOW \
  --rules=tcp:80 \
  --direction=EGRESS \
  --destination-ranges=169.254.169.254/32 \
  --target-tags=sandbox-vm \
  --priority=900 \
  --network=${VPC_NETWORK} \
  --description="Sandbox VMs -> GCE metadata server"
```

**Priority model**: deny-all at 1000, explicit Cloud SQL deny at 500 (immovable), allow rules at 900. Lower number = higher priority. The Cloud SQL deny at 500 cannot be overridden by any allow rule at 900.

**Validation**: After deployment, SSH into a sandbox VM and verify:
```bash
# Must fail:
curl -s --connect-timeout 3 ${CLOUDSQL_IP}:5432 && echo "FAIL: can reach Cloud SQL" || echo "OK: Cloud SQL blocked"
# Must succeed:
curl -s --connect-timeout 3 ${ILB_IP}:3001/api/health && echo "OK: ILB reachable" || echo "FAIL: ILB blocked"
curl -s --connect-timeout 3 https://bedrock-runtime.us-east-1.amazonaws.com && echo "OK: HTTPS egress works" || echo "FAIL: HTTPS blocked"
```

### 10.6 Secrets management

**Threat model**: untrusted agent code runs inside the VM with full shell access. Any secret placed in VM metadata, environment variables, or filesystem is readable by the agent (e.g., `curl http://metadata.google.internal/...`). Therefore, secrets must be partitioned by blast radius.

**Principle**: The VM never holds secrets that grant access beyond what the sandbox-server needs. The VM never gets DATABASE_URL or any credential that reaches shared infrastructure (Postgres, BookStack admin, GKE internals). All cloud credentials on VMs are short-lived.

**Secret tiers**:

| Tier | Where stored | Accessible from VM? | Lifetime | Examples |
|------|-------------|---------------------|----------|----------|
| Control plane | GKE secrets / Secret Manager, API env only | No | Long-lived (rotated quarterly) | DATABASE_URL, BookStack admin tokens, GCP SA keys |
| LLM inference | VM metadata | Yes | Short-lived (1h STS) | AWS Bedrock session credentials |
| Vendor API proxy | API env only | No | Long-lived (API key) | Brave Search API key, Gemini API key (proxied through API) |
| API callback | VM metadata | Yes | Short-lived (1h JWT) | Per-VM bearer token for `/api/internal/*` |
| Per-agent | VM metadata | Yes | Static | agent-id, api-callback-url |

#### 10.6.1 Short-lived AWS credentials (mandatory)

**Do not inject long-lived IAM keys into VMs.** Use AWS STS AssumeRole to generate temporary credentials at VM creation time.

```typescript
// In gce.ts createVM() — called by API (which holds the long-lived IAM role):
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const sts = new STSClient({ region: 'us-east-1' });
const { Credentials } = await sts.send(new AssumeRoleCommand({
  RoleArn: process.env.BEDROCK_ROLE_ARN,       // arn:aws:iam::...:role/sandbox-bedrock-access
  RoleSessionName: `sandbox-${agentId}`,
  DurationSeconds: 3600                          // 1 hour
}));

metadata: {
  items: [
    { key: 'agent-id', value: agentId },
    { key: 'api-callback-url', value: ILB_IP + ':3001' },  // Internal Load Balancer
    { key: 'vm-token', value: generateVMToken(agentId, agent.vm_token_generation) },  // 1h JWT for /api/internal/*
    // Short-lived Bedrock credentials (1h expiry)
    { key: 'aws-access-key-id', value: Credentials.AccessKeyId },
    { key: 'aws-secret-access-key', value: Credentials.SecretAccessKey },
    { key: 'aws-session-token', value: Credentials.SessionToken },
    // NOTE: No GEMINI_API_KEY — Gemini calls proxied through API.
    // NOTE: No BRAVE_API_KEY — Brave calls proxied through API.
    // NOTE: No DATABASE_URL — Cloud SQL is API-only.
    // NOTE: No BookStack admin tokens — wiki tools are API-mediated.
  ]
}
```

**Credential refresh**: The sandbox-server refreshes both STS credentials **and** VM JWT before expiry. See section 10.6.2 for the full refresh loop — both are returned together from the same endpoint. The long-lived IAM role ARN never leaves the API.

**If the agent exfiltrates the STS credentials**: they expire in 1 hour. The IAM role is scoped to `bedrock:InvokeModel` only — no S3, no EC2, no IAM access.

**If the agent exfiltrates the VM JWT**: While the VM is running on the same generation, an attacker with a leaked token **can** call any `/api/internal/*` route from anywhere (including off-VM) and refresh indefinitely. `validateVMToken` checks generation on every request but has no way to distinguish the legitimate sandbox-server from an off-VM caller holding the same token. This is an inherent limitation: the VM JWT is a bearer token, and the agent has shell access to read it.

Mitigations that bound the damage:
1. **Lifecycle revocation on all routes**: `validateVMToken` checks `vm_token_generation` on **every** internal route (not just refresh). Any VM lifecycle transition (stop, delete, GPU swap, restart) increments the generation before the action, instantly revoking all outstanding tokens across all internal endpoints. Idle VMs are stopped after 15 min (CPU) / 60 min (GPU).
2. **Scoped blast radius**: The token grants access only to that agent's resources — wiki search, Brave search proxy, and Bedrock inference for one agent. No access to other agents, Postgres, BookStack admin, or cloud infrastructure.
3. **STS credential scope**: Exfiltrated STS credentials are limited to `bedrock:InvokeModel`. No S3, EC2, or IAM access.
4. **Rate limiting**: Credential endpoints are rate-limited per agent (2/10min refresh, 3/10min bootstrap) with a per-pod circuit breaker (1000/min per pod). See section 10.6.4.
5. **Monitoring**: Anomalous patterns (429 rate-limit hits, concurrent callers on the same agent token, calls from non-VPC IPs) can be detected via API request logs and alerted on.

**Accepted residual risk**: While a VM is running on a given generation, a leaked token enables use of that agent's scoped internal routes from any network location. The damage is bounded by: (a) per-agent rate limits on credential endpoints — refresh is limited to 2/10min and bootstrap to 3/10min, preventing STS/JWT churn (section 10.6.4); (b) per-agent rate limits on vendor API proxies — Brave search limited to 100/hour (section 10.6.4); (c) STS credentials scoped to `bedrock:InvokeModel` only; (d) a per-pod circuit breaker at 1000 req/min per API pod. The risk terminates immediately when the VM lifecycle changes (generation increment).

#### 10.6.2 Per-VM bearer tokens

Each VM gets a short-lived JWT (1h) for calling `/api/internal/*` endpoints. The token is refreshed alongside STS credentials on the same 50-minute interval. Agent runs can exceed 60 minutes, so the refresh loop is mandatory.

```typescript
// API: generate VM token (includes token generation for revocation)
function generateVMToken(agentId: string, generation: number): string {
  return jwt.sign({ agentId, type: 'vm', gen: generation }, process.env.VM_TOKEN_SECRET, { expiresIn: '1h' });
}

// API: /api/internal/agents/:agentId/refresh-credentials
// validateVMToken already verified: JWT signature, type, agentId match,
// vm_status in ('running','upgrading'), and vm_token_generation match.
// Rate-limited: 2 per agent per 10 minutes (normal cadence is 1 per 50 min).
app.post('/api/internal/agents/:agentId/refresh-credentials',
  validateVMToken, rateLimitCredentialRefresh, async (req, res) => {
  const agentId = req.vmAgentId;
  const stsCredentials = await assumeBedrockRole(agentId);
  const newVmToken = generateVMToken(agentId, req.vmTokenGeneration);
  res.json({ credentials: stsCredentials, vmToken: newVmToken });
});

// API: middleware on /api/internal/* routes
// Enforces: JWT signature, type, resource binding, AND generation (DB-backed revocation).
// Generation check runs on EVERY internal route, not just refresh. This ensures that
// a stale/leaked token from a previous VM lifecycle is rejected immediately, even for
// read-only tool routes (wiki search, Brave proxy, etc.).
async function validateVMToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.VM_TOKEN_SECRET);
    if (payload.type !== 'vm') return res.status(403).json({ error: 'Invalid token type' });
    // Resource binding: VM can only access its own agent's resources
    if (req.params.agentId && payload.agentId !== req.params.agentId) {
      return res.status(403).json({ error: 'Agent ID mismatch' });
    }
    // DB-backed generation check: rejects tokens from previous VM lifecycles.
    // This is the revocation mechanism — incrementing vm_token_generation in the DB
    // instantly invalidates all previously issued tokens on ALL internal routes.
    const agent = await vmInternalQuery(
      "SELECT vm_token_generation, vm_status FROM agents WHERE id = $1",
      [payload.agentId]
    );
    if (agent.rows.length === 0) {
      return res.status(403).json({ error: 'Unknown agent' });
    }
    if (agent.rows[0].vm_token_generation !== payload.gen) {
      return res.status(403).json({ error: 'Token revoked (generation mismatch)' });
    }
    if (!['running', 'upgrading'].includes(agent.rows[0].vm_status)) {
      return res.status(403).json({ error: 'Agent VM not running' });
    }
    req.vmAgentId = payload.agentId;
    req.vmTokenGeneration = payload.gen;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
}
```

**VM-JWT routes must be agent-scoped**: All `/api/internal/*` endpoints authenticated via `validateVMToken` use the pattern `/api/internal/agents/:agentId/...` so the middleware can enforce that the VM token's `agentId` matches the URL parameter. A VM for agent A cannot query wiki results scoped to agent B. The one exception is `/api/internal/bootstrap-credentials`, which uses GCE identity-token auth and derives the agentId from the verified instance name (see section 10.6.3).

**Token refresh in sandbox-server** (runs alongside STS refresh):
```typescript
// sandbox-server: credential + token refresh loop
setInterval(async () => {
  const res = await fetch(`http://${API_CALLBACK_URL}/api/internal/agents/${AGENT_ID}/refresh-credentials`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VM_TOKEN}` }
  });
  const { credentials, vmToken } = await res.json();
  // Update both STS and VM token atomically
  process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
  VM_TOKEN = vmToken;  // module-level variable used by all tool callbacks
}, 50 * 60 * 1000); // 50 min (before 60 min expiry)
```

**If refresh fails**: sandbox-server retries 3 times with exponential backoff. On 429 (rate-limited), it uses the `Retry-After` header for backoff duration instead of exponential. If all retries fail:

1. **Token still valid** (< 60 min since last refresh): log warning, continue. Next refresh interval will retry.
2. **Token expired** (> 60 min since last success): the VM token is dead — it cannot authenticate to the refresh endpoint. Recovery:
   - The sandbox-server falls back to **GCE instance identity token** re-authentication. GCE VMs can always request a signed identity token from the metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=mines-ai-api`). This token is signed by Google and proves the VM's identity (including its service account and instance name).
   - The API exposes a **bootstrap endpoint**: `POST /api/internal/bootstrap-credentials` that accepts a GCE instance identity token (not a VM JWT), verifies it via Google's token verification API, extracts the instance name (`sandbox-<agentId>`), and returns fresh STS credentials + a new VM JWT.
   - This endpoint is separate from the normal refresh path and only accepts instance identity tokens, not expired VM JWTs.

```typescript
// sandbox-server: fallback re-bootstrap when JWT is expired
async function rebootstrap(): Promise<void> {
  // GCE identity token — always available from metadata server, no credentials needed
  const identityToken = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=mines-ai-api&format=full',
    { headers: { 'Metadata-Flavor': 'Google' } }
  ).then(r => r.text());

  const res = await fetch(`http://${API_CALLBACK_URL}/api/internal/bootstrap-credentials`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${identityToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT_ID })
  });
  const { credentials, vmToken } = await res.json();
  // Update credentials atomically
  process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
  VM_TOKEN = vmToken;
}

// API: bootstrap endpoint — accepts GCE identity tokens only
// This is a high-privilege endpoint (issues STS + JWT), so verification is strict.
// Rate-limited inline: 3 per agent per 10 minutes, applied after GCE token verification (step 5).
app.post('/api/internal/bootstrap-credentials', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  // 1. Verify GCE identity token signature and standard claims
  const payload = await verifyGCEIdentityToken(token, {
    audience: 'mines-ai-api',                           // must match VM's requested audience
    issuer: 'https://accounts.google.com',              // Google-issued
  });

  // 2. Verify GCP project number (prevents cross-project tokens)
  const gce = payload.google?.compute_engine;
  if (gce?.project_number !== process.env.GCP_PROJECT_NUMBER) {
    return res.status(403).json({ error: 'Wrong GCP project' });
  }

  // 3. Verify service account is our dedicated sandbox SA
  const expectedSA = `sandbox-vm@${process.env.GCP_PROJECT_ID}.iam.gserviceaccount.com`;
  if (payload.email !== expectedSA || !payload.email_verified) {
    return res.status(403).json({ error: 'Unexpected service account' });
  }

  // 4. Extract instance name and derive agentId
  const instanceName = gce?.instance_name;
  if (!instanceName?.startsWith('sandbox-')) {
    return res.status(403).json({ error: 'Not a sandbox VM' });
  }
  const agentId = instanceName.replace('sandbox-', '');

  // 5. Apply rate limit keyed on verified agentId (3 per 10 min)
  const rateLimitResult = checkRateLimit('bootstrap', agentId, { max: 3, windowMs: 600_000 });
  if (!rateLimitResult.allowed) {
    res.set('Retry-After', String(rateLimitResult.retryAfterSec));
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // 6. Verify instance exists in agents table (prevents spoofed instance names)
  const agent = await vmInternalQuery(
    "SELECT id, vm_token_generation FROM agents WHERE id = $1 AND vm_name = $2 AND vm_status IN ('running', 'upgrading')",
    [agentId, instanceName]
  );
  if (agent.rows.length === 0) {
    return res.status(403).json({ error: 'Unknown or inactive agent VM' });
  }

  // All checks pass — issue fresh credentials with current generation
  const stsCredentials = await assumeBedrockRole(agentId);
  const newVmToken = generateVMToken(agentId, agent.rows[0].vm_token_generation);
  res.json({ credentials: stsCredentials, vmToken: newVmToken });
});
```

3. **API unreachable** (network issue, not token issue): sandbox-server logs error and continues operating with whatever credentials it has. Internal tool calls (wiki, KB, Brave) will fail with auth errors — the agent sees tool failures, which is acceptable. Bedrock STS credentials have independent expiry and may still work. The idle monitor will eventually shut down the VM if it remains unreachable.

#### 10.6.3 Services the VM cannot reach

Enforced by VPC firewall (section 10.5) + no credentials:
- Cloud SQL (Postgres) — explicit DENY egress rule at priority 500, no DATABASE_URL
- BookStack admin API — no admin tokens, no firewall path
- GKE internal services — no credentials, no firewall path

#### 10.6.4 API-mediated tools (wiki, vendor APIs)

In current state, wiki tools call BookStack REST API directly and Brave Search is called with a long-lived API key. In target state, **all** of these are API-mediated calls via the ILB — the VM holds no vendor API keys.

```typescript
// sandbox-server tool implementations (target state):
// All tools call back to API ILB instead of external services directly.

// wiki_search → API → BookStack
{
  name: 'wiki_search',
  execute: async ({ query }) => {
    const res = await fetch(`http://${API_CALLBACK_URL}/api/internal/agents/${AGENT_ID}/wiki/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${VM_TOKEN}` }
    });
    return res.json();
  }
}

// web_search → API → Brave Search (API holds BRAVE_API_KEY)
{
  name: 'web_search',
  execute: async ({ query, count }) => {
    const res = await fetch(`http://${API_CALLBACK_URL}/api/internal/agents/${AGENT_ID}/brave/search`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VM_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count })
    });
    return res.json();
  }
}

```

**API internal endpoints** (in `src/routes/internal.ts`):

```typescript
// Agent-scoped routes use validateVMToken middleware (section 10.6.2)
// and enforce agentId resource binding.
// The bootstrap route uses GCE identity-token auth instead (section 10.6.3).
// Tool proxy routes use rateLimitPerAgent (keyed on req.vmAgentId, set by
// validateVMToken). The refresh-credentials route uses its own stricter
// rateLimitCredentialRefresh (2/10min). See rate limit table in section 10.6.4.

router.get('/agents/:agentId/wiki/search', validateVMToken, rateLimitPerAgent, async (req, res) => {
  // API queries BookStack with admin tokens
  // Per-agent rate limit: 200 requests/hour (wiki lookups are frequent during research)
});

router.post('/agents/:agentId/brave/search', validateVMToken, rateLimitPerAgent, async (req, res) => {
  // API calls Brave Search with BRAVE_API_KEY
  // Per-agent rate limit: 100 requests/hour (configurable per org)
});
```

**Per-agent rate limits** on vendor API proxies prevent a runaway agent from exhausting API quotas. Limits are configurable per org (stored in `organizations.settings`). Default: 100 Brave requests/hour per agent.

**Rate limits on all internal routes** prevent abuse from leaked tokens or buggy loops:

| Endpoint | Key | Limit | Window | Rationale |
|----------|-----|-------|--------|-----------|
| `/refresh-credentials` | agentId (from JWT) | 2 | 10 min | Normal cadence is 1/50min. 2/10min allows retry. |
| `/bootstrap-credentials` | agentId (from verified GCE token) | 3 | 10 min | Bootstrap is rare. Rate limit runs after token verification (see below). |
| `/wiki/search` | agentId | 200 | 1 hour | Wiki lookups are frequent during research tasks. |
| `/brave/search` | agentId | 100 | 1 hour | Configurable per org via `organizations.settings`. |
| All `/api/internal/*` | per-pod aggregate | 1000 | 1 min | Per-pod circuit breaker. With N replicas, effective aggregate is N*1000/min. |

Rate limits are enforced in-memory per API pod. With N replicas, each pod independently enforces its limits. **Both** per-agent and aggregate limits scale with pod count: with round-robin routing, a single agent can achieve up to N times the stated per-agent limit (e.g., 2 pods × 2/10min refresh = 4/10min effective). This is an accepted tradeoff — the primary security bound is the short token lifetime (1h) and generation-based revocation, not the rate limit precision. Per-agent limits remain useful as a coarse brake on abuse within each pod, and the per-pod aggregate (1000/min per pod) is a safety net against broad flooding, not a precise global cap. A shared rate-limit store (e.g., Redis) would close this gap but is deferred until monitoring shows it is needed.

**Bootstrap rate limit ordering**: The bootstrap endpoint applies its rate limit **inline** (step 5) after GCE identity token verification and agentId extraction (steps 1-4), not as Express middleware. This ensures the rate limit keys on the verified agentId rather than an unauthenticated request parameter.

All 429 responses set the `Retry-After` HTTP header (seconds until the window resets). The JSON body contains only `{ "error": "Rate limit exceeded" }` — the retry delay is communicated exclusively via the header, per RFC 6585. The sandbox-server retry logic (section 10.6.2) reads `Retry-After` and backs off accordingly.

The API validates the VM token, calls external services using its own credentials, and returns results. No vendor API keys, BookStack tokens, or DATABASE_URL ever enter the VM.

#### 10.6.5 Startup script

```bash
#!/bin/bash
# /opt/sandbox/startup.sh
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
export AGENT_ID=$(curl -s "$META/agent-id" -H "$HDR")
export API_CALLBACK_URL=$(curl -s "$META/api-callback-url" -H "$HDR")
export VM_TOKEN=$(curl -s "$META/vm-token" -H "$HDR")
# Short-lived STS credentials (1h)
export AWS_ACCESS_KEY_ID=$(curl -s "$META/aws-access-key-id" -H "$HDR")
export AWS_SECRET_ACCESS_KEY=$(curl -s "$META/aws-secret-access-key" -H "$HDR")
export AWS_SESSION_TOKEN=$(curl -s "$META/aws-session-token" -H "$HDR")
# No GEMINI_API_KEY — Gemini calls proxied through API
# No BRAVE_API_KEY — Brave calls proxied through API
# No DATABASE_URL, no BookStack tokens

# Mount data disk
DATA_DISK="/dev/sdb"
MOUNT_POINT="/workspace"
if ! blkid "$DATA_DISK" &>/dev/null; then
  mkfs.ext4 -m 0 -F "$DATA_DISK"
fi
mkdir -p "$MOUNT_POINT"
mount -o discard,defaults "$DATA_DISK" "$MOUNT_POINT"

cd /opt/sandbox
exec node dist/sandbox-server.js >> /var/log/sandbox-server.log 2>&1
```

### 10.7 Nginx Ingress (on GKE)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mines-ai-ingress
  namespace: mines-ai
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "18000"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "18000"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
spec:
  tls:
  - hosts:
    - ai.mines.edu
    secretName: mines-ai-tls
  rules:
  - host: ai.mines.edu
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-svc
            port:
              number: 3001
      - path: /bookstack
        pathType: Prefix
        backend:
          service:
            name: bookstack-svc
            port:
              number: 80
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend-svc
            port:
              number: 80
```

**Blocking `/api/internal/*` from public access** (two layers):

1. **Cryptographic auth on every internal route (primary control)**: Every `/api/internal/*` request must present a valid credential that an external attacker cannot forge. Agent-scoped routes (`/api/internal/agents/:agentId/*`) require a per-VM JWT (signed with `VM_TOKEN_SECRET`, which never leaves the API) validated by `validateVMToken` middleware (section 9.10). The bootstrap endpoint (`/api/internal/bootstrap-credentials`) requires a GCE instance identity token (signed by Google) verified against project number, service account, and instance name. No internal route is accessible without one of these credentials — the auth check is the primary control, not network position. Note: agent code running inside the VM *can* read the VM JWT from metadata (see threat model in section 10.6). A leaked token can be refreshed from anywhere while the VM is running on the same generation. Mitigations: generation-based revocation on all lifecycle transitions (stop/delete/swap), scoped blast radius (one agent's resources only), and per-agent rate limits. See accepted residual risk in section 10.6.1.

```typescript
// All /api/internal/agents/:agentId/* routes:
//   Auth: per-VM JWT (issued at VM creation, stored in VM metadata)
//   Middleware: validateVMToken enforces agentId in token matches URL :agentId
//
// /api/internal/bootstrap-credentials:
//   Auth: GCE instance identity token (Google-signed, non-forgeable)
//   Verified: project number, service account, instance name, agent existence
```

2. **Network-level separation (defense-in-depth)**: Sandbox VMs reach the API via the GKE Internal Load Balancer defined in section 10.5.1 (`api-internal-svc`, type: LoadBalancer with `networking.gke.io/load-balancer-type: "Internal"`). This provides a stable VPC-internal IP reachable only within the VPC. The public Nginx ingress routes `/api` to `api-svc` (the public-facing ClusterIP Service). Even though both services target the same API pods, legitimate VM traffic flows through the ILB path. An external attacker **without** a leaked token reaching `/api/internal/*` via the public ingress would fail at layer 1 (no valid JWT or GCE identity token). However, as documented in section 10.6.1, a leaked VM JWT **does** allow off-VM callers to use internal routes from any network path, including the public ingress — the ILB is defense-in-depth, not a hard boundary.

Note: no IP-based or header-based filtering is used. CIDR checks are too broad (ingress controllers, internal pods, and VMs can share RFC 1918 ranges) and custom headers can be spoofed. Cryptographic verification of caller identity is the only reliable control when the same pods serve both public and internal routes.

Critical for SSE: `proxy-read-timeout: "18000"` (5 hours) and `proxy-buffering: "off"`.

## 11. Authentication and multi-tenancy

### 11.1 Authentication

Current state: Phase 5 is implemented.

- Auth provider modes:
  - `AUTH_PROVIDER=none`: dev/test bypass mode with auto-provisioned user
  - `AUTH_PROVIDER=oidc`: real OIDC login flow
- Session management:
  - `express-session` with `HttpOnly`, `SameSite=Lax`, `secure` in production
  - `SESSION_SECRET` required in production
  - Session fixation protection via `req.session.regenerate()` on login/callback
- Route protection:
  - `/api/auth/login` and `/api/auth/callback` are pre-auth routes
  - `/api/auth/logout` is session + CSRF protected and idempotent
  - `/api/auth/me` and all other `/api/*` app routes run behind auth middleware
- User context:
  - Auth middleware populates `req.user` and `req.orgId`
  - Tenant-scoped queries use `withOrgContextQuery(req.orgId, ...)`
- OIDC hardening:
  - PKCE (`code_verifier`, `code_challenge`) + state + nonce
  - OIDC discovery is cached process-wide

Future compatibility remains: CAS/SAML can be added later if needed for specific universities, but OIDC is the implemented provider in this phase.

### 11.2 Multi-tenancy

**Tenant = organization.** Each university or research group is one organization. Users belong to exactly one org. Agents and skills are scoped to an org.

**Tenant isolation**: Two layers — application-level `WHERE org_id` on every query **and** PostgreSQL Row-Level Security (RLS) as a mandatory safety net. RLS is required for GA.

**Layer 1: Application-level filtering** (defense in depth, not sole defense):

```typescript
// Express middleware sets req.org from authenticated user
app.use('/api/*', async (req, res, next) => {
  // After auth middleware populates req.user:
  req.org = { id: req.user.orgId };
  next();
});

// Every data query includes org filter:
const agents = await query(
  'SELECT * FROM agents WHERE org_id = $1 ORDER BY created_at DESC',
  [req.org.id]
);
```

**Layer 2: PostgreSQL RLS** (mandatory for GA, catches application-layer bugs):

The API connects to Postgres as a limited-privilege role (`app_user`), not as superuser. RLS policies enforce org scoping even if application code omits the `WHERE org_id` clause.

```sql
-- Migration: enable RLS on all tenant-scoped tables

-- 1. Create application role (not superuser — RLS applies)
-- Scoped grants: only tables app routes actually need, not blanket ALL TABLES.
CREATE ROLE app_user LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON agents, skills, agent_skills,
  agent_chat_sessions, agent_chat_messages, agent_access TO app_user;
-- organizations/users: read-only for app routes (creation/bootstrap handled by auth_bootstrap_user)
GRANT SELECT ON organizations TO app_user;
GRANT SELECT ON users TO app_user;
-- No grant on pg_* system tables, no CREATE/DROP/ALTER.
-- If a profile-edit route is added later, grant UPDATE (name) ON users TO app_user.

-- 2a. VM callback role (BYPASSRLS for /api/internal/* routes, least-privilege)
-- Used by VM callback routes only. Separate from auth bootstrap to isolate trust domains.
CREATE ROLE internal_vm_user LOGIN PASSWORD '...' BYPASSRLS;
GRANT SELECT ON agents TO internal_vm_user;                     -- vm_status, vm_ip lookups
GRANT UPDATE (vm_status, vm_ip, vm_name, vm_zone, vm_token_generation, gpu_active, gpu_type, last_activity_at, data_disk_name)
  ON agents TO internal_vm_user;                                -- VM lifecycle updates only
GRANT SELECT ON agent_chat_sessions TO internal_vm_user;        -- session validation
-- No access to: organizations, users, skills, agent_access, agent_chat_messages
-- A bug in a VM callback route cannot read or write org/user data.

-- 2b. Auth bootstrap role (BYPASSRLS for SSO login flow, least-privilege)
-- Used only by auth callback to create orgs/users on first login.
CREATE ROLE auth_bootstrap_user LOGIN PASSWORD '...' BYPASSRLS;
GRANT SELECT, INSERT ON organizations TO auth_bootstrap_user;   -- org lookup/create
GRANT SELECT, INSERT ON users TO auth_bootstrap_user;           -- user lookup/create
GRANT UPDATE (name) ON users TO auth_bootstrap_user;            -- ON CONFLICT upsert updates name from SSO
-- Cannot modify org settings, user roles, or user org_id.
-- No access to: agents, skills, agent_access, agent_chat_sessions, agent_chat_messages
-- A bug in auth code cannot read agent data, chat history, or VM state.

-- 3. Enable RLS on tables with direct org_id
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
-- organizations: users can only see their own org
CREATE POLICY orgs_isolation ON organizations
  USING (id = current_setting('app.current_org_id', true)::uuid);

-- users: users can see other users within their org (for sharing UI)
CREATE POLICY users_org_isolation ON users
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY agents_org_isolation ON agents
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
CREATE POLICY skills_org_read ON skills FOR SELECT
  USING (org_id IS NULL OR org_id = current_setting('app.current_org_id', true)::uuid);
  -- SELECT: tenants can read their own skills AND platform-wide shared skills (org_id = NULL)
CREATE POLICY skills_org_write ON skills FOR INSERT
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
CREATE POLICY skills_org_update ON skills FOR UPDATE
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
CREATE POLICY skills_org_delete ON skills FOR DELETE
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
  -- INSERT/UPDATE/DELETE: tenants can only write to their own org's skills.
  -- org_id = NULL (platform-wide) skills are created by superuser migrations only.
  -- WITH CHECK prevents a missed app-layer org assignment from creating a global skill.

-- 4. Enable RLS on tables scoped via joins (use subqueries)
ALTER TABLE agent_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_org_isolation ON agent_chat_sessions
  USING (agent_id IN (SELECT id FROM agents WHERE org_id = current_setting('app.current_org_id', true)::uuid));

CREATE POLICY messages_org_isolation ON agent_chat_messages
  USING (session_id IN (
    SELECT s.id FROM agent_chat_sessions s
    JOIN agents a ON s.agent_id = a.id
    WHERE a.org_id = current_setting('app.current_org_id', true)::uuid
  ));

CREATE POLICY access_org_isolation ON agent_access
  USING (agent_id IN (SELECT id FROM agents WHERE org_id = current_setting('app.current_org_id', true)::uuid));

CREATE POLICY agent_skills_org_isolation ON agent_skills
  USING (agent_id IN (SELECT id FROM agents WHERE org_id = current_setting('app.current_org_id', true)::uuid));
```

**Agent-level ACL enforcement (accepted risk)**:

RLS policies enforce **org-level** isolation only. Per-agent access control (owner/editor/viewer from `agent_access`) is enforced at the **application layer** in route handlers (e.g., "verify `req.user` has 'owner' role in `agent_access`"). This means:

- A missed or buggy app-layer check could allow a user within the same org to read/write another user's agent data.
- Cross-org access is still impossible (RLS prevents it at the DB layer regardless of app bugs).

This is an accepted trade-off because: (1) implementing per-user RLS requires passing both `app.current_org_id` and `app.current_user_id` as session variables, with complex sub-select policies on every table that joins through `agent_access` — the query planner overhead and policy complexity are significant; (2) the blast radius of a missed check is limited to same-org users, not cross-tenant leaks; (3) route handlers are the primary enforcement point and are testable.

**Mandatory mitigation**: Every route handler that accesses agent-scoped data must have integration tests verifying that: (a) owner access succeeds, (b) editor/viewer access is appropriately restricted, (c) a same-org user with no `agent_access` row is rejected. These tests run in CI and are a Phase 5 requirement (see implementation sequence). Without this test coverage, the accepted-risk status is not valid.

**Upgrade path**: If stricter DB-level enforcement is needed later, add `app.current_user_id` as a second session variable and extend RLS policies with `agent_access` joins.

**Setting org context per request** (in the query helper):

`set_config('app.current_org_id', $1, true)` is transaction-local — it only persists for the transaction in which it's called. Without an explicit transaction, each `client.query()` call runs in its own implicit transaction, so the config is lost before the actual query executes. The fix: wrap `SET LOCAL` + query in an explicit transaction.

```typescript
// Tenant-scoped connection pool (app_user role, RLS applies)
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL }); // app_user role

// VM callback pool for /api/internal/* routes (bypasses RLS, agents + sessions only)
const vmInternalPool = new Pool({ connectionString: process.env.VM_INTERNAL_DATABASE_URL }); // internal_vm_user

// Auth bootstrap pool for SSO login (bypasses RLS, organizations + users only)
const authBootstrapPool = new Pool({ connectionString: process.env.AUTH_BOOTSTRAP_DATABASE_URL }); // auth_bootstrap_user

// Tenant-scoped query: explicit transaction wraps SET LOCAL + query
export async function query(text: string, params?: any[], orgId?: string) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (orgId) {
      // SET LOCAL is transaction-scoped: cleared on COMMIT/ROLLBACK
      await client.query("SET LOCAL app.current_org_id = $1", [orgId]);
    } else {
      // Fail closed: org context is not set. current_setting(..., true) returns
      // NULL when unset. NULL::uuid is NULL, and (org_id = NULL) is always false
      // in SQL, so RLS policies reject all rows. Zero results, not an error.
    }
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// VM internal query (for /api/internal/* routes, no RLS, agents/sessions only)
export async function vmInternalQuery(text: string, params?: any[]) {
  const client = await vmInternalPool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Auth bootstrap query (for SSO login flow, no RLS, organizations/users only)
export async function authBootstrapQuery(text: string, params?: any[]) {
  const client = await authBootstrapPool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Usage in routes:
const agents = await query(
  'SELECT * FROM agents ORDER BY created_at DESC',
  [],
  req.org.id  // RLS enforces org scoping even without WHERE clause
);
```

**Fail-closed behavior** (two layers):

1. **Middleware layer** (primary): Express middleware rejects requests missing org context with 403 before they reach the DB. This catches programming errors early and gives a clear error message.

```typescript
// Express middleware: reject requests without org context
app.use('/api/*', (req, res, next) => {
  if (req.path.startsWith('/api/internal/')) return next(); // VM callbacks use JWT, not org
  if (!req.org?.id) {
    return res.status(403).json({ error: 'Missing org context' });
  }
  next();
});
```

2. **DB layer** (safety net): If a query somehow bypasses the middleware without `orgId`, `current_setting('app.current_org_id', true)` returns `NULL` (the `true` parameter means "return NULL if missing" instead of throwing an error). `NULL::uuid` is `NULL`, and `org_id = NULL::uuid` evaluates to `NULL` (not `true`) in SQL, so `USING (org_id = current_setting(...))` rejects all tenant-scoped rows. Result: zero tenant-scoped rows returned, not a cross-tenant leak or a 500 error. **Exception**: the `skills_org_read` policy allows `org_id IS NULL` (platform-wide shared skills), so global skills remain visible even without org context. This is safe because shared skills are read-only to tenants (INSERT/UPDATE/DELETE policies require a matching org), and the fail-closed middleware prevents this path from being reached in normal operation.

**Why `current_setting(..., true)`**: Without the second `true` argument, `current_setting()` throws an error when the setting is unset, which would cause a 500 instead of a safe empty result. The `true` argument makes it return `NULL` on missing settings.

**Transaction semantics**: `SET LOCAL` + query in one transaction guarantees the org context is active during the query and automatically cleared on `COMMIT`/`ROLLBACK`. No risk of context leaking to the next request on the same pooled connection.

**Internal API routes** (`/api/internal/*`) use `vmInternalQuery()` with the `internal_vm_user` connection pool. This role has `BYPASSRLS` (needed since no org context is set for VM callbacks) but is **not** superuser — it can only SELECT/UPDATE specific columns on `agents` and SELECT on `agent_chat_sessions`. It has **no access** to organizations, users, skills, or chat messages.

**Auth callback** uses `authBootstrapQuery()` with the `auth_bootstrap_user` connection pool. This role also has `BYPASSRLS` (needed since `req.org` is not yet set during first-login) but is **not** superuser — it can only SELECT/INSERT on `organizations` and `users`, plus column-level UPDATE(name) on `users` (needed for the `ON CONFLICT (email) DO UPDATE SET name` upsert in step 4). It cannot modify org settings, user roles, or user org_id. The INSERT grant is constrained at the endpoint level: the auth bootstrap code path only writes fields derived from SSO claims (domain, email, name), not arbitrary values. This role has **no access** to agents, skills, sessions, or chat messages.

**Org provisioning flow** (uses `authBootstrapQuery()` — runs as `auth_bootstrap_user` with `BYPASSRLS`):

The auth callback runs **before** `req.org` is set, so it cannot use the tenant-scoped `app_user` pool. All org/user lookups and creation during login use `authBootstrapQuery()` via the `auth_bootstrap_user` connection pool, which has `BYPASSRLS` and SELECT/INSERT grants on `organizations` and `users` only.

1. User logs in via SSO. Auth callback extracts email and lowercases both email and domain: `const email = ssoEmail.toLowerCase(); const domain = email.split('@')[1];`. All downstream queries use these canonicalized values. This prevents duplicate identities from case variation (e.g., `Mines.edu` vs `mines.edu`).
2. Auth callback uses `INSERT INTO organizations ... ON CONFLICT ((LOWER(domain))) DO NOTHING RETURNING *` to atomically create-or-skip the org. The `ON CONFLICT` targets the `organizations_domain_lower` functional index (not a plain column constraint), so it correctly matches even if a legacy row has mixed case.
3. If INSERT returned no row (org already existed): `SELECT ... FROM organizations WHERE LOWER(domain) = $1` to get the existing org (query uses the same lowercase value from step 1).
4. User upsert: `INSERT INTO users (org_id, email, name, role) VALUES ($1, $2, $3, $4) ON CONFLICT ((LOWER(email))) DO UPDATE SET name = EXCLUDED.name RETURNING *`. The `ON CONFLICT` targets the `users_email_lower` functional index. Role is `admin` if user created the org (step 2 returned a row), `member` otherwise.
5. Auth middleware sets `req.org` and `req.user` from the result — subsequent route handlers use `app_user` with RLS

All queries in steps 2-4 run as `authBootstrapQuery()` (`auth_bootstrap_user` with `BYPASSRLS`).

**Cross-org isolation**:
- Users cannot see agents, skills, or conversations from other orgs
- VM labels include `org=<slug>` for billing/audit
- Skills can be `org_id = NULL` for platform-wide shared skills (e.g., "Web Search"), but only readable by tenants — INSERT/UPDATE/DELETE restricted to own org by RLS `WITH CHECK`. Global skills are created by superuser migrations only.
- Admins within an org can see all agents in their org

**Per-org limits** (stored in `organizations.settings` JSONB):
- `max_agents`: maximum number of agents per org (default: 50)
- `max_gpu_hours_monthly`: GPU compute budget (default: 100 hours)
- `default_machine_type`: default VM size for new agents
- `max_disk_size_gb`: maximum workspace disk size per agent

## 12. End-to-end request flows (target state)

### 12.1 Agent creation

```text
1. User fills out form: name, system prompt
   (No machine type selector — all agents start on CPU)
2. Browser POST /api/agents { name, systemPrompt }
3. API inserts agent into Postgres (org_id=req.org.id, vm_status='creating')
4. API inserts agent_access: { agentId, userId: req.user.id, role: 'owner' }
5. API calls gce.createDataDisk(agentId, 20)
6. API calls gce.createVM(agentId, 'e2-medium') -- always CPU
7. API returns agent immediately (frontend shows "Creating...")
8. Frontend polls GET /api/agents/:id until vm_status='running' (~20s)
9. Agent is ready. User can chat and browse workspace.
```

### 12.2 Agent page load (VM may be stopped)

```text
1. User clicks agent in sidebar
2. Frontend: GET /api/agent-chat/:agentId/latest (loads chat history from Postgres, instant)
3. Frontend: POST /api/sandbox/:agentId/ensure (starts VM if stopped)
4. User reads previous messages, starts typing
5. VM resumes (always CPU, ~5-10s from suspend, hidden behind page load)
6. User sends message -> forwarded to VM -> works
```

### 12.3 Agent chat with multiple conversations

```text
1. User has conversation A open, sends message
2. API: POST VM:8888/chat { sessionId: "session-A", message, ... }
3. VM: creates or reuses pi-agent session for session-A
4. VM streams SSE events -> API pipes to browser

5. User opens new conversation tab (session-B)
6. API: POST VM:8888/chat { sessionId: "session-B", message, ... }
7. VM: creates new pi-agent session for session-B
8. Both sessions can run concurrently, share /workspace filesystem
```

### 12.4 Idle shutdown

```text
1. Idle monitor (every 60s) finds agent with last_activity_at > 15min ago
2. API: GET VM:8888/status -> { busy: false, gpuNeeded: false }
3. If gpu_active=true and gpuNeeded=false:
   -> API calls gce.downgradeToCpu(agentId)
   -> Resets idle timer (don't immediately suspend the fresh CPU VM)
4. If on CPU VM and idle > 15min:
   -> API calls gce.suspendVM(agentId) -> vm_status='stopped'
5. VM compute charges stop. Data disk persists (~$0.80/mo for 20GB).
```

### 12.5 Workspace file access

```text
1. User is on agent page -> VM is running (ensured on page load)
2. Browser: GET /api/workspace/:agentId/files
3. API: GET VM:8888/files
4. Returns file tree to browser
5. User clicks file -> GET /api/workspace/:agentId/file?path=report.pdf&raw=true
6. API: GET VM:8888/file?path=report.pdf&raw=true
7. Pipes binary content to browser for preview
```

### 12.6 GPU upgrade during conversation

```text
1. User chatting with agent on CPU VM
2. Agent decides it needs GPU for ML training
3. Agent calls request_gpu({ reason: "Fine-tune BERT classifier", estimatedMinutes: 60 })
4. Sandbox-server: marks session in gpuSessions, sends SSE event to browser:
   { type: 'gpu_request', data: { reason, gpuType: 'nvidia-tesla-t4', estimatedCost: '$0.60' }}
5. Browser shows dialog: "Agent requests GPU: Fine-tune BERT (~1h, ~$0.60) [Approve] [Deny]"
6. User clicks Approve
7. Browser: POST /api/sandbox/:agentId/gpu/approve
8. API: sets vm_status='upgrading', calls gce.upgradeToGpu(agentId, 'nvidia-tesla-t4')
   (stop CPU VM -> detach data disk -> delete CPU VM -> create GPU VM -> attach disk -> start)
9. ~30-40s: frontend shows "Upgrading to GPU..." progress
10. GPU VM ready. API updates: vm_status='running', gpu_active=true, vm_ip=<new>
11. Sandbox-server on new GPU VM gets /gpu-approved callback, unblocks tool call
12. Agent resumes: runs CUDA training code with GPU access
13. Training complete. Agent calls release_gpu()
14. Sandbox-server removes session from gpuSessions
15. Idle monitor detects gpuNeeded=false, downgrades to CPU (~30-40s)
16. Agent continues on CPU VM. Workspace fully intact.
```

### 12.7 Multi-user shared conversation

```text
1. User A (owner) creates a shared conversation for agent X
2. API: INSERT INTO agent_chat_sessions (agent_id, created_by, shared) VALUES (X, A, true)
3. User A shares agent X with User B (role: editor)
4. API: INSERT INTO agent_access (agent_id, user_id, role) VALUES (X, B, 'editor')

5. User A opens shared conversation, connects SSE
6. User B opens same shared conversation, connects SSE
7. User A sends message "Analyze the dataset"
8. API saves message (user_id=A), forwards to VM, streams SSE to both A and B
9. Agent responds, both users see the response in real-time
10. User B sends follow-up "Also check for outliers"
11. API saves message (user_id=B), forwards to VM, streams SSE to both A and B
12. Both users see each other's messages and all agent responses
13. Chat UI shows user names/avatars next to each message
```

### 12.8 Skill update propagation

```text
1. Skill updated via /api/skills/:id
2. Library package regenerated
3. For each agent with this skill installed:
   a. If VM running: POST VM:8888/upload skill files to /workspace/skills/
   b. If VM stopped: mark skill as dirty; re-inject on next VM start
   c. Update agent_skills metadata in Postgres
```

## 13. Local development

Current local development runs API + frontend directly, with Docker only for backing services.

```jsonc
// package.json
{
  "predev": "(lsof -ti:3001,5173 | xargs kill 2>/dev/null) || true && pnpm run dev:setup",
  "dev:setup": "docker compose up -d postgres bookstack && ... && pnpm db:migrate",
  "dev": "concurrently -k ... \"tsx watch src/index.ts\" \"pnpm run client:dev\""
}
```

```bash
# start local stack
pnpm dev
```

Test workflow:
- `pnpm dev` auto-starts `postgres` + `bookstack`, waits for Postgres readiness, and applies migrations
- `pnpm test:all` for fast local coverage (unit + integration + client tests)
- `pnpm test:full` for full coverage (includes Playwright e2e)
- CI runs lint, typecheck, unit, integration, client, e2e, and Docker builds

## 14. Deployment architecture

### 14.1 Docker Compose (development, current)

Services: `postgres`, `bookstack`, `bookstack-db`

API/frontend run as local Node/Vite processes via `pnpm dev`. Compose is infra-only in dev.

### 14.2 Production (GKE + GCE)

| Component | Where | Replicas |
|-----------|-------|----------|
| Frontend (static) | GKE Deployment | 1 |
| API | GKE Deployment | 2 |
| BookStack | GKE Deployment | 1 |
| BookStack DB | GKE StatefulSet (PVC with scheduled backups) | 1 |
| PostgreSQL | Cloud SQL (managed) | 1 (HA optional) |
| Redis | Memorystore (managed) | 1 |
| Sandbox VMs | GCE (one per agent) | 0-N (created on demand) |

### 14.3 Cost estimate (200 users, 25 active agents daily, 4 hrs avg usage)

All agents start on CPU. GPU is only used on-demand (e.g., 5 agents x 30 min/day average GPU time).

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| GKE Autopilot (API + services) | ~4 vCPU, ~8GB | ~$100 |
| Cloud SQL | db-custom-2-8192, 20GB | ~$120 |
| CPU VMs running (25 agents x 4 hrs/day) | e2-medium | ~$100 |
| Data disks (200 agents, 20GB each) | pd-ssd, stopped | ~$160 |
| GPU on-demand (5 agents x 0.5 hrs/day) | n1-std-4 + T4 | ~$20 |
| Memorystore Redis (shared session pub/sub) | 1GB Basic | ~$30 |
| Network egress | ~10GB | ~$1 |
| **Total** | | **~$530/mo** |

Key savings vs. pre-provisioned GPU:
- Old model: 10 GPU VMs stopped = $20/mo disk + running = $50/mo compute
- New model: 0 GPU VMs pre-provisioned. GPU spun up on-demand, agent runs on CPU otherwise. ~$20/mo GPU compute for occasional bursts. Data disks persist cheaply.

## 15. Non-functional requirements

- **Streaming latency**: SSE events from VM to browser with no buffering. Nginx `proxy_buffering off`.
- **VM startup time**: ~20s creation, ~5-10s resume (CPU), ~20s restart (GPU).
- **Durability**: chat history in Postgres (survives everything). Workspace on persistent disk (survives stop/start). Only lost on VM deletion.
- **Isolation**: full VM isolation per agent. No shared kernel.
- **Availability**: API replicated (2+). Cloud SQL with automated backups. BookStack DB: single StatefulSet with PVC — not HA. See below.
- **BookStack DB durability**: BookStack runs its own MySQL/MariaDB in a StatefulSet with a PersistentVolumeClaim (GCE PD). This is not managed — no automated backups or failover. Mitigation: (1) daily `mysqldump` CronJob writes to a dedicated GCS bucket (`gs://${PROJECT_ID}-bookstack-backups/`, separate from Cloud SQL automated backups which are managed internally by Cloud SQL and not stored in a user bucket); (2) PVC uses `pd-ssd` with GCE snapshot schedule (daily, 7-day retention); (3) if the StatefulSet pod is rescheduled, the PVC reattaches automatically. For HA, BookStack DB could be migrated to Cloud SQL for MySQL, but the added cost is not justified at current scale. BookStack content is curated wiki content (recoverable from source materials), not transactional data — RPO of 24 hours is acceptable.
- **Observability**: structured logging, GCE serial console for VM debugging, Cloud Monitoring.

## 16. Known implementation notes

- Drizzle schema (`src/db/schema.ts`) is the source of truth; SQL files in `src/db/migrations/` are generated/customized via drizzle-kit.
- Legacy `schema_migrations` was removed in `src/db/migrations/0004_drop_legacy_schema_migrations.sql`.
- Legacy vector-search tables/services (`crawled_pages`, `page_chunks`, `crawl_jobs`, `chat_history`) were removed as part of the agentic-search transition.
- pi-coding-agent version: `^0.53.0` (check for updates before deployment).
- **Gemini fallback is text-only, no tools.** The Gemini orchestrator path runs in the API process (no VM) and must NOT be given tool definitions (no `web_search`, `wiki_search`, `web_fetch`, `read_file`, `write_file`, `bash`, etc.). It exists solely as a degraded-mode text responder when the primary Sonnet/sandbox path is unavailable or for non-agent conversational queries. Any path that executes tools or accesses the filesystem must go through the sandboxed VM runtime. This is a firm security boundary: the API process never executes untrusted code or agent-invoked tools.

## 17. Implementation sequence

**Phase 0: Prerequisites**
1. Set up GCP project, enable APIs (GKE, Compute Engine, Cloud SQL, Memorystore, Service Networking)
2. Create dedicated VPC (`mines-ai-vpc`) and subnet — do not use `default` VPC
3. Enable Private Services Access on VPC (for Cloud SQL private IP)
4. Create Cloud SQL for PostgreSQL with private IP only (`--no-assign-ip`, in the VPC)
5. Create GKE Autopilot cluster in the VPC
6. Create Memorystore Redis instance (in the same VPC)
7. Create dedicated sandbox-vm service account (logging + monitoring write only)
8. Create VPC firewall rules for API-to-VM communication (section 10.5)
9. Build and save base VM images (CPU and GPU variants)

**Phase 1: Build sandbox-server**
1. Create `sandbox/` directory with its own `package.json`
2. Implement `sandbox/sandbox-server.ts`:
   - HTTP server on port 8888
   - POST /chat with multi-session support (`Map<sessionId, session>`) and per-session turn serialization (409 reject on concurrent requests to same sessionId)
   - GET /status (with `gpuNeeded` field), GET /health
   - File endpoints: GET /files, GET /file, POST /upload, DELETE /file
   - GPU tracking: `gpuSessions` Set, `request_gpu` / `release_gpu` tool handlers
   - Data disk mount logic in startup script
3. Move pi-agent session/stream/tools code from `src/services/pi-agent/` to `sandbox/src/`
4. Add `request_gpu` and `release_gpu` tool definitions
5. Test locally: run sandbox-server, curl POST /chat, verify SSE works

**Phase 2: Build SandboxClient + GCE manager**
1. Implement `src/services/sandbox/gce.ts`:
   - createDataDisk, createVM, startVM, stopVM, deleteVM, deleteDataDisk
   - upgradeToGpu, downgradeToCpu (VM swap with data disk reattach)
2. Implement `src/services/sandbox/client.ts` (local/gce mode abstraction)
3. Add schema migration: agents table gains machine_type, gpu_type, gpu_active, vm_status, vm_name, vm_ip, data_disk_name, vm_zone, vm_token_generation, last_activity_at
4. Test: create data disk + VM, POST /chat to it, verify full flow

**Phase 3: Authentication + multi-tenancy**
1. Add schema migration: organizations, users tables
2. Add org_id to agents and skills tables
3. Implement SSO integration (`src/routes/auth.ts`): CAS/SAML/OIDC
4. Add auth middleware on all `/api/*` routes (populates `req.user`, `req.org`)
5. Add `WHERE org_id = $1` to all data queries
6. Create `app_user` Postgres role (non-superuser), enable RLS on all tenant-scoped tables (section 11.2)
7. Update query helper to wrap `SET LOCAL app.current_org_id` + query in explicit transactions
8. Create two BYPASSRLS Postgres roles: `internal_vm_user` (agents/sessions only, for `/api/internal/*` VM callbacks) and `auth_bootstrap_user` (organizations/users only, for SSO login flow), each with a separate connection pool
9. Implement org auto-provisioning on first login from new domain
10. Test: login via SSO, verify org isolation. Test RLS: confirm queries without `WHERE org_id` still return only current org data

**Phase 4: Multi-user agent access**
1. Add schema migration: agent_access table
2. Add agent_chat_sessions.created_by, agent_chat_sessions.shared, agent_chat_messages.user_id
3. Implement access control checks on agent/chat/workspace routes
4. Implement agent sharing API: POST /api/agents/:id/share, DELETE /api/agents/:id/share/:userId
5. Implement shared session SSE broadcasting (sessionId -> Set<Response>)
6. Add `src/routes/internal.ts`: API-mediated endpoints for sandbox callbacks:
   - `/api/internal/agents/:agentId/wiki/search` — BookStack proxy
   - `/api/internal/agents/:agentId/brave/search` — Brave Search proxy (per-agent rate limits)
   - `/api/internal/agents/:agentId/refresh-credentials` — STS + JWT refresh
   - `/api/internal/bootstrap-credentials` — emergency re-auth via GCE instance identity token
7. Test: two users chatting in shared session, SSE broadcast works
8. Test: vendor API proxy endpoints (Brave) with rate limits

**Phase 5: Modify API routes**
1. Modify `src/routes/agents.ts`: create data disk + CPU VM on create, delete both on delete, share endpoints
2. Modify `src/routes/agent-chat.ts`: proxy to VM via SandboxClient, access checks, shared session broadcast
3. Modify `src/routes/workspace.ts`: proxy file ops to VM via SandboxClient, access checks
4. Add `src/routes/sandbox.ts`: ensure/heartbeat/release + GPU approve/deny endpoints with per-agent advisory locks (`pg_advisory_xact_lock`)
5. Implement `src/services/sandbox/idle-monitor.ts` (with GPU downgrade logic, leader election via `pg_try_advisory_lock`)
6. Test full flow: create agent -> VM boots -> chat -> GPU upgrade -> downgrade -> idle -> shutdown -> resume
7. **Required (accepted-risk mitigation)**: Add agent-level authorization integration tests for every route that accesses agent-scoped data. Each test must verify: (a) owner access succeeds, (b) editor/viewer access is appropriately restricted, (c) same-org user without `agent_access` row is rejected. Run in CI.

**Phase 6: Frontend changes**
1. Add VM status indicator on agent page (running/starting/stopped/upgrading)
2. Add startup spinner / progress UI
3. Add /ensure call on agent page mount + heartbeat interval
4. Add conversation tabs (multiple sessions per agent)
5. Add GPU approval dialog (handle `gpu_request` SSE event)
6. Add "Upgrading to GPU..." progress UI
7. Add agent sharing UI (settings page, user search, role assignment)
8. Add shared conversation support (user avatars, create shared session)
9. Add per-org filtering for agent/skill lists
10. Add login/SSO flow

**Phase 7: Production deployment**
1. **Release blocker** [owner: platform-lead]: Run migration to drop legacy tables: `DROP TABLE IF EXISTS page_chunks, crawled_pages, crawl_jobs, chat_history`
2. **Release blocker** [owner: platform-lead]: Remove or repurpose `Mines Knowledge Base` seed skill (references deleted `search_knowledge_base` tool type) — either delete from migration `001`/`002` or add migration `004` to clean up
3. Deploy API + frontend + BookStack to GKE
4. Configure Nginx Ingress with TLS
5. Set up Cloud Monitoring and alerts
6. Configure Cloud SQL backups
7. Configure BookStack DB backups: daily `mysqldump` CronJob to GCS + PVC snapshot schedule
8. Load test with simulated users
9. Set up CI/CD pipeline
10. Per-org billing reports via GCE VM labels

**Phase 8: Cleanup**
1. Remove `src/services/pi-agent/` from API package (now in sandbox)
2. Remove `data/workspaces/` and `data/agents/` host directories
3. Update docker-compose.yml for local dev with sandbox-server
4. Final review and update of this document
