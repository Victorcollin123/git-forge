// Shared in-memory store: repos, git objects, issues, pull requests.
// One store serves REST, MCP and GraphQL so ids never drift between surfaces.
// Determinism: REST-created commits use a fixed identity and a fixed epoch
// plus a per-repo counter as the timestamp; no Date.now()/random anywhere.

import { createHash } from 'node:crypto';
import { VIEWER, SCENARIO_EPOCH_SEC, EPOCH_ISO, DEFAULT_BRANCH } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const COMMIT_AUTHOR_NAME = VIEWER.name;
export const COMMIT_AUTHOR_EMAIL = VIEWER.email;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
  /** Cached serialization of issueView(); null when stale. */
  restJson: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  seq: number;
  /** Cached serialization of pullView(); null when stale. */
  restJson: Buffer | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  commitSeq: number;
  /** Cached serialization of repoView(); null when stale. */
  restJson: Buffer | null;
}

export interface Store {
  repos: Map<string, Repo>;
  repoIdSeq: number;
  issueIdSeq: number;
  pullIdSeq: number;
}

export const store: Store = {
  repos: new Map(),
  repoIdSeq: 1,
  issueIdSeq: 1,
  pullIdSeq: 1,
};

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

/** Repos owned by the viewer, in creation order. */
export function viewerRepos(): Repo[] {
  const out: Repo[] = [];
  for (const repo of store.repos.values()) {
    if (repo.owner === VIEWER.login) out.push(repo);
  }
  return out;
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: store.repoIdSeq++,
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    issueSeq: 1,
    pullSeq: 1,
    commentSeq: 1,
    commitSeq: 0,
    restJson: null,
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------- git objects

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const hash = createHash('sha1');
  hash.update(header);
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorTs: number;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let authorTs = SCENARIO_EPOCH_SEC;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) authorTs = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, authorTs, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort: entries compared by name, directories as if ending in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries.slice());
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  timestamp: number;
}): Buffer {
  const ident = `${COMMIT_AUTHOR_NAME} <${COMMIT_AUTHOR_EMAIL}> ${opts.timestamp} +0000`;
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

/** Deterministic timestamp for a REST-created commit in this repo. */
export function nextCommitTimestamp(repo: Repo): number {
  return SCENARIO_EPOCH_SEC + repo.commitSeq++;
}

/** Create a commit object in the repo and return its oid. */
export function createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const data = buildCommit({ tree, parents, message, timestamp: nextCommitTimestamp(repo) });
  return storeObject(repo, 'commit', data);
}

export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(refName(branch));
}

/** Flatten a tree into path -> {oid, mode} for every blob under it. */
export function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

/** The blob oid at `path` in the tree rooted at `treeOid`, or null. */
export function blobAtPath(repo: Repo, treeOid: string, segments: string[]): string | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i++) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** All ancestors of `start` (inclusive), newest first, deduped. */
export function commitAncestors(repo: Repo, start: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parsed = parseCommit(obj.data);
    for (let i = parsed.parents.length - 1; i >= 0; i--) stack.push(parsed.parents[i]);
  }
  return out;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(repo, descendant).includes(ancestor);
}

/** First common ancestor of a and b, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aSet = new Set(commitAncestors(repo, a));
  for (const oid of commitAncestors(repo, b)) {
    if (aSet.has(oid)) return oid;
  }
  return null;
}

// ---------------------------------------------------------------- tree edits

/** Set (or replace) the blob at `segments` in the tree, returning the new tree oid. */
export function setPathInTree(repo: Repo, treeOid: string | null, segments: string[], blobOid: string): string {
  const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  } else {
    const childTree = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    const newChild = setPathInTree(repo, childTree, rest, blobOid);
    const entry: TreeEntry = { mode: '40000', name: head, oid: newChild };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  }
  return storeObject(repo, 'tree', buildTree(entries));
}

/** Remove the file at `segments` from the tree; prunes trees left empty. Returns the new tree oid, or null if the file was absent. */
export function removePathFromTree(repo: Repo, treeOid: string, segments: string[]): string | null {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return null;
  const entries = parseTree(obj.data);
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (idx < 0) return null;
  if (rest.length === 0) {
    if (entries[idx].mode === '40000') return null;
    entries.splice(idx, 1);
  } else {
    if (entries[idx].mode !== '40000') return null;
    const newChild = removePathFromTree(repo, entries[idx].oid, rest);
    if (newChild === null) return null;
    if (newChild === entries[idx].oid) return treeOid;
    // Rebuild: if the child tree is now empty, drop the entry.
    const childObj = repo.objects.get(newChild);
    const childEntries = childObj ? parseTree(childObj.data) : [];
    if (childEntries.length === 0) entries.splice(idx, 1);
    else entries[idx] = { mode: '40000', name: head, oid: newChild };
  }
  return storeObject(repo, 'tree', buildTree(entries));
}

// ---------------------------------------------------------------- contents

export interface WriteResult {
  commitSha: string;
  blobSha: string;
  created: boolean;
}

/**
 * Write a file on `branch` (creating the branch from the default tip when it
 * does not exist, or as the first commit when the repo is unborn).
 * Throws an Error with `status` 409 on a stale/missing sha.
 */
export function writeContent(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  sha?: string,
): WriteResult {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    const err = new Error('Path is required') as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  const ref = refName(branch);
  let parentOid = repo.refs.get(ref);
  if (!parentOid && branch !== repo.defaultBranch) {
    parentOid = repo.refs.get(refName(repo.defaultBranch));
  }
  let parentTree: string | null = null;
  if (parentOid) {
    const obj = repo.objects.get(parentOid);
    if (obj && obj.type === 'commit') parentTree = parseCommit(obj.data).tree;
  }
  const currentBlob = parentTree ? blobAtPath(repo, parentTree, segments) : null;
  if (sha !== undefined) {
    if (!currentBlob || currentBlob !== sha) {
      const err = new Error('sha does not match the current blob') as Error & { status?: number };
      err.status = 409;
      throw err;
    }
  } else if (currentBlob) {
    const err = new Error('sha is required to update an existing file') as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  const blobSha = storeObject(repo, 'blob', content);
  const newTree = setPathInTree(repo, parentTree, segments, blobSha);
  const parents = parentOid ? [parentOid] : [];
  const commitSha = createCommit(repo, newTree, parents, message);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha, created: currentBlob === null };
}

export function deleteContent(repo: Repo, branch: string, path: string, message: string, sha?: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const ref = refName(branch);
  const parentOid = repo.refs.get(ref);
  if (!parentOid) {
    const err = new Error('Not Found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const parent = repo.objects.get(parentOid);
  if (!parent || parent.type !== 'commit') {
    const err = new Error('Not Found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const parentTree = parseCommit(parent.data).tree;
  const currentBlob = blobAtPath(repo, parentTree, segments);
  if (!currentBlob) {
    const err = new Error('Not Found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  if (sha !== undefined && sha !== currentBlob) {
    const err = new Error('sha does not match the current blob') as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  const newTree = removePathFromTree(repo, parentTree, segments);
  if (newTree === null) {
    const err = new Error('Not Found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const commitSha = createCommit(repo, newTree, [parentOid], message);
  repo.refs.set(ref, commitSha);
  return commitSha;
}

// ---------------------------------------------------------------- views

export function globalId(kind: string, ...parts: (string | number)[]): string {
  const raw = `${kind}:${parts.join(':')}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    pushed_at: EPOCH_ISO,
    html_url: `https://github.local/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.local/${repo.owner}/${repo.name}.git`,
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: issue.state === 'closed' ? EPOCH_ISO : null,
    html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: pull.state === 'closed' ? EPOCH_ISO : null,
    html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Cached REST serialization of a repo view (invalidated by PATCH). */
export function repoRestJson(repo: Repo): Buffer {
  if (repo.restJson === null) repo.restJson = Buffer.from(JSON.stringify(repoView(repo)), 'utf8');
  return repo.restJson;
}

/** Cached REST serialization of an issue view (invalidated by PATCH/comment). */
export function issueRestJson(repo: Repo, issue: Issue): Buffer {
  if (issue.restJson === null) issue.restJson = Buffer.from(JSON.stringify(issueView(repo, issue)), 'utf8');
  return issue.restJson;
}

/** Cached REST serialization of a pull view (invalidated by merge). */
export function pullRestJson(repo: Repo, pull: Pull): Buffer {
  if (pull.restJson === null) pull.restJson = Buffer.from(JSON.stringify(pullView(repo, pull)), 'utf8');
  return pull.restJson;
}

/** Serialize a list of cached view buffers as one JSON array buffer. */
export function restJsonList(buffers: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from('[', 'utf8')];
  for (let i = 0; i < buffers.length; i++) {
    if (i > 0) parts.push(Buffer.from(',', 'utf8'));
    parts.push(buffers[i]);
  }
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- issues/PRs

export function createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) {
      const err = new Error(`Label does not exist: ${name}`) as Error & { status?: number };
      err.status = 422;
      throw err;
    }
    labels.push(label);
  }
  const issue: Issue = {
    id: store.issueIdSeq++,
    number: repo.issueSeq++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: repo.issues.length,
    restJson: null,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (!headSha || !baseSha) {
    const err = new Error('head or base branch not found') as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  for (const p of repo.pulls) {
    if (p.state === 'open' && p.head === head) {
      const err = new Error('A pull request already exists for this head branch') as Error & { status?: number };
      err.status = 422;
      throw err;
    }
  }
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  if (!baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') {
    const err = new Error('head or base is not a commit') as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  const mb = mergeBase(repo, headSha, baseSha) ?? baseSha;
  const pull: Pull = {
    id: store.pullIdSeq++,
    number: repo.pullSeq++,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head,
    base,
    headSha,
    baseSha,
    mergeBaseSha: mb,
    seq: repo.pulls.length,
    restJson: null,
  };
  repo.pulls.push(pull);
  return pull;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Diff base tip tree vs head tip tree, with line counts. */
export function diffPullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headObj = repo.objects.get(pull.headSha);
  const baseObj = repo.objects.get(pull.baseSha);
  if (!headObj || !baseObj || headObj.type !== 'commit' || baseObj.type !== 'commit') return [];
  const headMap = new Map<string, { oid: string; mode: string }>();
  const baseMap = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, parseCommit(headObj.data).tree, '', headMap);
  flattenTree(repo, parseCommit(baseObj.data).tree, '', baseMap);
  const paths = new Set<string>([...headMap.keys(), ...baseMap.keys()]);
  const out: FileChange[] = [];
  for (const path of paths) {
    const h = headMap.get(path);
    const b = baseMap.get(path);
    if (h && b && h.oid === b.oid) continue;
    let status: 'added' | 'modified' | 'removed';
    let additions = 0;
    let deletions = 0;
    const oldLines = b ? countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)) : [];
    const newLines = h ? countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)) : [];
    if (!b && h) status = 'added';
    else if (b && !h) status = 'removed';
    else status = 'modified';
    // Multiset intersection of lines: shared lines are context, the rest changed.
    const counts = new Map<string, number>();
    for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of newLines) {
      const c = counts.get(l) ?? 0;
      if (c > 0) {
        counts.set(l, c - 1);
        common += 1;
      }
    }
    additions = newLines.length - common;
    deletions = oldLines.length - common;
    out.push({ path, status, additions, deletions, changes: additions + deletions });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** True when the PR cannot merge cleanly (a file changed on both sides differently). */
export function pullIsConflicted(repo: Repo, pull: Pull): boolean {
  const headObj = repo.objects.get(pull.headSha);
  const mbObj = repo.objects.get(pull.mergeBaseSha);
  // The base side is the CURRENT base branch tip, not the tip at creation:
  // another PR may have merged since, moving the base past the merge-base.
  const currentBaseSha = branchTip(repo, pull.base) ?? pull.baseSha;
  const baseObj = repo.objects.get(currentBaseSha);
  if (!headObj || !baseObj || !mbObj) return false;
  if (headObj.type !== 'commit' || baseObj.type !== 'commit' || mbObj.type !== 'commit') return false;
  const headMap = new Map<string, { oid: string; mode: string }>();
  const baseMap = new Map<string, { oid: string; mode: string }>();
  const mbMap = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, parseCommit(headObj.data).tree, '', headMap);
  flattenTree(repo, parseCommit(baseObj.data).tree, '', baseMap);
  flattenTree(repo, parseCommit(mbObj.data).tree, '', mbMap);
  const paths = new Set<string>([...headMap.keys(), ...baseMap.keys(), ...mbMap.keys()]);
  for (const path of paths) {
    const h = headMap.get(path)?.oid ?? null;
    const b = baseMap.get(path)?.oid ?? null;
    const m = mbMap.get(path)?.oid ?? null;
    const headChanged = h !== m;
    const baseChanged = b !== m;
    if (headChanged && baseChanged && h !== b) return true;
  }
  return false;
}

/** Squash-merge the PR onto its base branch. Returns the merge commit sha. */
export function mergePull(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') {
    const err = new Error('Pull request is not open') as Error & { status?: number };
    err.status = 405;
    throw err;
  }
  if (pullIsConflicted(repo, pull)) {
    const err = new Error('Merge conflict') as Error & { status?: number };
    err.status = 405;
    throw err;
  }
  const headObj = repo.objects.get(pull.headSha);
  // The squash commit's parent is the CURRENT base branch tip.
  const currentBaseSha = branchTip(repo, pull.base) ?? pull.baseSha;
  const baseObj = repo.objects.get(currentBaseSha);
  if (!headObj || !baseObj || headObj.type !== 'commit' || baseObj.type !== 'commit') {
    const err = new Error('head or base is not a commit') as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  const headTree = parseCommit(headObj.data).tree;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
  const mergeSha = createCommit(repo, headTree, [currentBaseSha], message);
  repo.refs.set(refName(pull.base), mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = EPOCH_ISO;
  pull.merge_commit_sha = mergeSha;
  pull.baseSha = mergeSha;
  pull.restJson = null;
  return mergeSha;
}
