// MCP over streamable HTTP (JSON-RPC 2.0) at POST /mcp.
// Modern era: server/discover (2026-07-28) is the primary handshake; the
// legacy initialize handshake is answered too. Tools act on the same store
// as REST and GraphQL.

import {
  store,
  getRepo,
  createRepo,
  createIssue,
  createPull,
  mergePull,
  repoView,
  issueView,
  pullView,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';

export const MCP_VERSION = '2026-07-28';
export const SERVER_NAME = 'makefun-git-forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The name of the head branch.' },
        base: { type: 'string', description: 'The name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function textResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function lookupRepo(args: Record<string, unknown>): Repo | null {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  if (!owner || !repo) return null;
  return getRepo(owner, repo) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      if (!repoName) return errorResult('Missing required argument: name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      if (getRepo(VIEWER.login, repoName)) return errorResult(`Repository ${VIEWER.login}/${repoName} already exists`);
      const repo = createRepo(VIEWER.login, repoName, description, isPrivate);
      return textResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = lookupRepo(args);
      if (!repo) return errorResult('Repository not found');
      return textResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = lookupRepo(args);
      if (!repo) return errorResult('Repository not found');
      const title = requireString(args, 'title');
      if (!title) return errorResult('Missing required argument: title');
      const body = typeof args.body === 'string' ? args.body : '';
      try {
        const issue = createIssue(repo, title, body, []);
        return textResult(issueView(repo, issue));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    case 'list_issues': {
      const repo = lookupRepo(args);
      if (!repo) return errorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => issueView(repo, i));
      return textResult(list);
    }
    case 'create_pull_request': {
      const repo = lookupRepo(args);
      if (!repo) return errorResult('Repository not found');
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      if (!title) return errorResult('Missing required argument: title');
      if (!head) return errorResult('Missing required argument: head');
      if (!base) return errorResult('Missing required argument: base');
      const body = typeof args.body === 'string' ? args.body : '';
      try {
        const pull = createPull(repo, title, body, head, base);
        return textResult(pullView(repo, pull));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(args);
      if (!repo) return errorResult('Repository not found');
      const num = args.pull_number;
      if (typeof num !== 'number' || !Number.isInteger(num)) {
        return errorResult('Missing required argument: pull_number');
      }
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return errorResult(`Pull request #${num} not found`);
      try {
        const sha = mergePull(repo, pull);
        return textResult({ merged: true, sha, number: pull.number, ...pullView(repo, pull) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

export interface McpOutcome {
  status: number;
  /** null body means: no body (notification acknowledgement). */
  body: string | null;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

/** Handle one POST /mcp request body. `body` is the raw request bytes. */
export function handleMcp(body: Buffer): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (Array.isArray(parsed)) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  const req = parsed as Record<string, unknown>;
  const id = 'id' in req ? req.id : undefined;
  const isNotification = id === undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (isNotification) return { status: 202, body: null };

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: MCP_VERSION,
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((t) => t.name === name);
    if (!known) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      const result = callTool(name, args);
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, errorResult((err as Error).message));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export { store };
