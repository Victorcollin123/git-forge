// The forge server: HTTP routing, auth, REST v3, and dispatch to MCP,
// GraphQL and git smart-HTTP. In-memory store; no Date.now()/random in state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER, EPOCH_ISO } from './scenario.ts';
import {
  store,
  getRepo,
  createRepo,
  viewerRepos,
  repoRestJson,
  issueRestJson,
  pullRestJson,
  restJsonList,
  createIssue,
  createPull,
  mergePull,
  diffPullFiles,
  writeContent,
  deleteContent,
  branchTip,
  parseCommit,
  commitAncestors,
  parseTree,
  type Repo,
} from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphQL } from './graphql.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let reqSeq = 0;
function nextRequestId(): string {
  reqSeq += 1;
  return `req-${reqSeq}`;
}

function sendJson(res: ServerResponse, status: number, obj: unknown, extraHeaders?: Record<string, string>): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return false;
  if (TOKEN) return token === TOKEN;
  return true;
}

const EMPTY_PARAMS = new URLSearchParams();

/** Lightweight request URL parse: the raw path plus query params (only built when a '?' is present). */
function parseRequestUrl(raw: string): { pathname: string; searchParams: URLSearchParams } {
  const q = raw.indexOf('?');
  if (q === -1) return { pathname: raw === '' ? '/' : raw, searchParams: EMPTY_PARAMS };
  return { pathname: raw.slice(0, q), searchParams: new URLSearchParams(raw.slice(q + 1)) };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: false };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function intParam(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function pageParams(url: { searchParams: URLSearchParams }): { perPage: number; page: number } {
  return {
    perPage: Math.min(100, Math.max(1, intParam(url.searchParams.get('per_page'), 30))),
    page: Math.max(1, intParam(url.searchParams.get('page'), 1)),
  };
}

/** Build a Link header for a paginated list, preserving the request's query. */
function linkHeader(req: IncomingMessage, url: { pathname: string; searchParams: URLSearchParams }, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const build = (p: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `http://${host}${url.pathname}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${build(page - 1)}>; rel="prev"`);
  parts.push(`<${build(1)}>; rel="first"`);
  parts.push(`<${build(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------- REST helpers

function needRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return getRepo(owner, name) ?? null;
}

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (!ref) return branchTip(repo, repo.defaultBranch) ?? null;
  const tip = branchTip(repo, ref);
  if (tip) return tip;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  return null;
}

function commitListView(repo: Repo, tip: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const oid of commitAncestors(repo, tip)) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const date = new Date(parsed.authorTs * 1000).toISOString();
    const nameMatch = /^(.*?) <[^>]*>/.exec(parsed.author);
    const emailMatch = /<([^>]*)>/.exec(parsed.author);
    const author = { name: nameMatch ? nameMatch[1] : '', email: emailMatch ? emailMatch[1] : '', date };
    out.push({
      sha: oid,
      commit: { message: parsed.message, author, committer: author },
      parents: parsed.parents.map((p) => ({ sha: p })),
    });
  }
  return out;
}

/** Resolve a tree path to a blob or a directory listing. */
function contentsLookup(
  repo: Repo,
  tip: string,
  segments: string[],
): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ mode: string; name: string; oid: string }> } | null {
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  for (let i = 0; i < segments.length; i++) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        const dir = repo.objects.get(entry.oid);
        if (!dir || dir.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(dir.data) };
      }
      const blob = repo.objects.get(entry.oid);
      if (!blob) return null;
      return { kind: 'file', oid: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return null;
  return { kind: 'dir', entries: parseTree(tree.data) };
}

// ---------------------------------------------------------------- REST router

async function handleRest(req: IncomingMessage, res: ServerResponse, url: { pathname: string; searchParams: URLSearchParams }, body: Buffer): Promise<void> {
  const segments = url.pathname.split('/').filter((s) => s.length > 0).map((s) => {
    if (!s.includes('%')) return s;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const rest = segments.slice(2); // after 'api'/'v3'
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      user_url: '/api/v3/users/{user}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta') {
    if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
      return sendJson(res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        created_at: EPOCH_ISO,
        updated_at: EPOCH_ISO,
      });
    }
    if (rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = viewerRepos();
        const { perPage, page } = pageParams(url);
        const link = linkHeader(req, url, page, perPage, repos.length);
        const body = restJsonList(pageSlice(repos, page, perPage).map((r) => repoRestJson(r)));
        return sendRaw(res, 200, 'application/json', body, link ? { link } : undefined);
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
        const name = str(parsed.value.name);
        if (!name) return errJson(res, 422, 'name is required');
        if (getRepo(VIEWER.login, name)) {
          return errJson(res, 422, `Repository ${VIEWER.login}/${name} already exists`);
        }
        const repo = createRepo(VIEWER.login, name, str(parsed.value.description), parsed.value.private === true);
        return sendRaw(res, 201, 'application/json', repoRestJson(repo));
      }
      return errJson(res, 405, 'Method Not Allowed');
    }
    return errJson(res, 404, 'Not Found');
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const repoName = rest[2];
    const repo = needRepo(owner, repoName);
    if (!repo) return errJson(res, 404, 'Not Found');
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return sendRaw(res, 200, 'application/json', repoRestJson(repo));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        if (typeof parsed.value.name === 'string' && parsed.value.name !== repo.name) {
          const newName = parsed.value.name as string;
          if (getRepo(owner, newName)) return errJson(res, 422, `Repository ${owner}/${newName} already exists`);
          store.repos.delete(`${owner}/${repo.name}`);
          repo.name = newName;
          store.repos.set(`${owner}/${newName}`, repo);
        }
        repo.restJson = null;
        return sendRaw(res, 200, 'application/json', repoRestJson(repo));
      }
      if (method === 'DELETE') {
        store.repos.delete(`${owner}/${repo.name}`);
        return sendNoContent(res, 204);
      }
      return errJson(res, 405, 'Method Not Allowed');
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
        const list = [...repo.refs.keys()]
          .filter((n) => n.startsWith('refs/heads/'))
          .map((n) => n.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string } }));
        return sendJson(res, 200, list);
      }
      if (tail.length === 2) {
        if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
        const tip = branchTip(repo, tail[1]);
        if (!tip) return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, { name: tail[1], commit: { sha: tip } });
      }
      return errJson(res, 404, 'Not Found');
    }

    if (tail[0] === 'commits') {
      if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
      const tip = resolveRef(repo, url.searchParams.get('sha'));
      if (!tip) return errJson(res, 404, 'Not Found');
      return sendJson(res, 200, commitListView(repo, tip));
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
        const ref = str(parsed.value.ref);
        const sha = str(parsed.value.sha);
        if (!ref.startsWith('refs/')) return errJson(res, 422, 'ref must start with refs/');
        if (!sha || !repo.objects.has(sha)) return errJson(res, 422, 'sha does not exist');
        if (repo.refs.has(ref)) return errJson(res, 422, 'Reference already exists');
        repo.refs.set(ref, sha);
        const obj = repo.objects.get(sha);
        return sendJson(res, 201, { ref, object: { sha, type: obj?.type ?? 'commit' } });
      }
      if (method === 'GET' && tail.length > 2) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) return errJson(res, 404, 'Not Found');
        const obj = repo.objects.get(sha);
        return sendJson(res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
      }
      return errJson(res, 404, 'Not Found');
    }

    if (tail[0] === 'contents') {
      const pathSegments = tail.slice(1);
      const branch = url.searchParams.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = resolveRef(repo, branch);
        if (!tip) return errJson(res, 404, 'Not Found');
        const found = contentsLookup(repo, tip, pathSegments);
        if (!found) return errJson(res, 404, 'Not Found');
        if (found.kind === 'file') {
          return sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: found.data.length,
            name: pathSegments[pathSegments.length - 1],
            path: pathSegments.join('/'),
            content: found.data.toString('base64'),
            sha: found.oid,
          });
        }
        return sendJson(res, 200, found.entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: [...pathSegments, e.name].join('/'),
          sha: e.oid,
        })));
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
        const contentB64 = str(parsed.value.content);
        if (!contentB64) return errJson(res, 422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errJson(res, 422, 'content is not valid base64');
        }
        const message = str(parsed.value.message) || `Update ${pathSegments.join('/')}`;
        const putBranch = str(parsed.value.branch) || branch;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        try {
          const result = writeContent(repo, putBranch, pathSegments.join('/'), content, message, sha);
          return sendJson(res, result.created ? 201 : 200, {
            content: { name: pathSegments[pathSegments.length - 1], path: pathSegments.join('/'), sha: result.blobSha, size: content.length, encoding: 'base64' },
            commit: { sha: result.commitSha },
          });
        } catch (err) {
          const e = err as Error & { status?: number };
          return errJson(res, e.status ?? 400, e.message);
        }
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
        const message = str(parsed.value.message) || `Delete ${pathSegments.join('/')}`;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        try {
          const commitSha = deleteContent(repo, branch, pathSegments.join('/'), message, sha);
          return sendJson(res, 200, { commit: { sha: commitSha }, content: null });
        } catch (err) {
          const e = err as Error & { status?: number };
          return errJson(res, e.status ?? 400, e.message);
        }
      }
      return errJson(res, 405, 'Method Not Allowed');
    }

    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      }
      if (method === 'POST' && tail.length === 1) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
        const name = str(parsed.value.name);
        if (!name) return errJson(res, 422, 'name is required');
        if (repo.labels.has(name)) return errJson(res, 422, `Label ${name} already exists`);
        const label = { name, color: str(parsed.value.color) || 'ededed', description: str(parsed.value.description) };
        repo.labels.set(name, label);
        return sendJson(res, 201, { name: label.name, color: label.color, description: label.description });
      }
      return errJson(res, 404, 'Not Found');
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let items = repo.issues.slice();
          if (state !== 'all') items = items.filter((i) => i.state === state);
          if (sort === 'created') items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { perPage, page } = pageParams(url);
          return sendRaw(res, 200, 'application/json', restJsonList(pageSlice(items, page, perPage).map((i) => issueRestJson(repo, i))));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
          const title = str(parsed.value.title);
          if (!title) return errJson(res, 422, 'title is required');
          const labelNames: string[] = [];
          if (Array.isArray(parsed.value.labels)) {
            for (const l of parsed.value.labels) {
              if (typeof l === 'string') labelNames.push(l);
              else if (typeof l === 'object' && l !== null && typeof (l as Record<string, unknown>).name === 'string') {
                labelNames.push((l as Record<string, unknown>).name as string);
              }
            }
          }
          try {
            const issue = createIssue(repo, title, str(parsed.value.body), labelNames);
            return sendRaw(res, 201, 'application/json', issueRestJson(repo, issue));
          } catch (err) {
            const e = err as Error & { status?: number };
            return errJson(res, e.status ?? 400, e.message);
          }
        }
        return errJson(res, 405, 'Method Not Allowed');
      }
      const issueNum = parseInt(tail[1], 10);
      if (!Number.isInteger(issueNum)) return errJson(res, 404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === issueNum);
      if (tail.length === 2) {
        if (!issue) return errJson(res, 404, 'Not Found');
        if (method === 'GET') return sendRaw(res, 200, 'application/json', issueRestJson(repo, issue));
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          if (parsed.value.state === 'closed') issue.state = 'closed';
          else if (parsed.value.state === 'open') issue.state = 'open';
          issue.restJson = null;
          return sendRaw(res, 200, 'application/json', issueRestJson(repo, issue));
        }
        return errJson(res, 405, 'Method Not Allowed');
      }
      if (tail[2] === 'comments') {
        if (!issue) return errJson(res, 404, 'Not Found');
        if (method === 'GET') {
          return sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: EPOCH_ISO })));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
          const commentBody = str(parsed.value.body);
          if (!commentBody) return errJson(res, 422, 'body is required');
          const comment = { id: repo.commentSeq++, body: commentBody };
          issue.comments.push(comment);
          issue.restJson = null;
          return sendJson(res, 201, { id: comment.id, body: comment.body, created_at: EPOCH_ISO });
        }
        return errJson(res, 405, 'Method Not Allowed');
      }
      return errJson(res, 404, 'Not Found');
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let items = repo.pulls.slice();
          if (state !== 'all') items = items.filter((p) => p.state === state);
          items.sort((a, b) => b.seq - a.seq);
          const { perPage, page } = pageParams(url);
          return sendRaw(res, 200, 'application/json', restJsonList(pageSlice(items, page, perPage).map((p) => pullRestJson(repo, p))));
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errJson(res, 400, 'Invalid JSON body');
          const title = str(parsed.value.title);
          const head = str(parsed.value.head);
          const base = str(parsed.value.base);
          if (!title || !head || !base) return errJson(res, 422, 'title, head and base are required');
          try {
            const pull = createPull(repo, title, str(parsed.value.body), head, base);
            return sendRaw(res, 201, 'application/json', pullRestJson(repo, pull));
          } catch (err) {
            const e = err as Error & { status?: number };
            return errJson(res, e.status ?? 400, e.message);
          }
        }
        return errJson(res, 405, 'Method Not Allowed');
      }
      const pullNum = parseInt(tail[1], 10);
      if (!Number.isInteger(pullNum)) return errJson(res, 404, 'Not Found');
      const pull = repo.pulls.find((p) => p.number === pullNum);
      if (tail.length === 2) {
        if (!pull) return errJson(res, 404, 'Not Found');
        if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
        return sendRaw(res, 200, 'application/json', pullRestJson(repo, pull));
      }
      if (tail[2] === 'files') {
        if (!pull) return errJson(res, 404, 'Not Found');
        if (method !== 'GET') return errJson(res, 405, 'Method Not Allowed');
        const files = diffPullFiles(repo, pull).map((f) => ({
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        return sendJson(res, 200, files);
      }
      if (tail[2] === 'merge') {
        if (!pull) return errJson(res, 404, 'Not Found');
        if (method !== 'PUT') return errJson(res, 405, 'Method Not Allowed');
        try {
          const sha = mergePull(repo, pull);
          return sendJson(res, 200, { sha, merged: true, message: `Pull Request #${pull.number} merged` });
        } catch (err) {
          const e = err as Error & { status?: number };
          return errJson(res, e.status ?? 400, e.message);
        }
      }
      return errJson(res, 404, 'Not Found');
    }

    return errJson(res, 404, 'Not Found');
  }

  return errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = parseRequestUrl(req.url ?? '/');
      const path = url.pathname;
      const isGet = req.method === 'GET';

      if (isGet && path === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      // Git smart HTTP (no auth).
      if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
        // GETs carry no body; resume() drains any unexpected bytes so the
        // keep-alive socket stays in sync.
        const body = isGet ? (req.resume(), Buffer.alloc(0)) : await readBody(req);
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
        const result = handleGit({ method: req.method ?? 'GET', path, query: url.searchParams, headers, body });
        if (result === null) return errJson(res, 404, 'Not Found');
        return sendRaw(res, result.status, result.contentType, result.body);
      }

      if (path === '/api/graphql') {
        if (!checkAuth(req)) return errJson(res, 401, 'Requires authentication');
        if (req.method !== 'POST') return errJson(res, 405, 'Method Not Allowed');
        const body = await readBody(req);
        const result = handleGraphQL(body);
        return sendRaw(res, result.status, 'application/json', Buffer.from(result.body, 'utf8'));
      }

      if (path === '/mcp') {
        if (!checkAuth(req)) return errJson(res, 401, 'Requires authentication');
        if (req.method === 'DELETE') return sendJson(res, 200, {});
        if (req.method !== 'POST') return errJson(res, 405, 'Method Not Allowed');
        const body = await readBody(req);
        const result = handleMcp(body);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
          return res.end();
        }
        return sendRaw(res, result.status, 'application/json', Buffer.from(result.body, 'utf8'));
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!checkAuth(req)) return errJson(res, 401, 'Requires authentication');
        const body = isGet ? (req.resume(), Buffer.alloc(0)) : await readBody(req);
        return handleRest(req, res, url, body);
      }

      return errJson(res, 404, 'Not Found');
    } catch (err) {
      if (!res.headersSent) {
        const e = err as Error;
        sendJson(res, 500, { message: e.message || 'Internal Server Error' });
      } else {
        res.destroy();
      }
    }
  });
  return server;
}
