// Git smart HTTP: pkt-line codec, packfile read/write (with delta resolution),
// fetch send-set planning, and the upload-pack / receive-pack handlers.
// Mirrors the wire shapes the kit's git-client expects (see sdk/conformance/git-client.ts).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  getRepo,
  hashObject,
  parseCommit,
  parseTree,
  ZERO_OID,
  type Repo,
  type GitObject,
  type GitObjectType,
} from './store.ts';
import { DEFAULT_BRANCH } from './scenario.ts';

const AGENT = 'makefun-git-forge/1.0';
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const MAX_PKT_LINE = 65520;
const SIDEBAND_CHUNK = MAX_PKT_LINE - 4 - 1; // 65515 bytes of pack data per packet

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktItem =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the start of `buf`. Parses until the first flush
 * packet (inclusive) or the end of the buffer; delim/response-end packets are
 * items, not terminators. Throws on a malformed length prefix.
 */
export function decodePktLines(buf: Buffer): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4) throw new Error(`pkt-line length ${len} is too small`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
    items.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { items, consumed: offset };
}

/** Sideband-wrap pack bytes into band-1 pkt-lines. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < pack.length; i += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pack codec

function readVarintSize(buffer: Buffer, start: number): { size: number; first: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry header is truncated');
  let byte = buffer[start];
  let offset = start + 1;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, first, next: offset };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

/** Read a packfile (v2/v3), resolving OFS/REF deltas; returns oid -> object. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buffer = pack;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer does not match its bytes');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), deterministic order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- fetch planning

function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

function collectTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  out.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') collectTreeObjects(repo, e.oid, out);
    else out.add(e.oid);
  }
}

interface WalkResult {
  commits: Map<string, number>;
  objects: Set<string>;
}

/**
 * Walk commits from `roots`. `maxDepth` truncates by generation (roots are
 * generation 1); `stopAt` includes a boundary commit and its tree/blobs but
 * does not descend to its parents.
 */
function walkCommits(repo: Repo, roots: string[], opts: { maxDepth?: number; stopAt?: Set<string> }): WalkResult {
  const commits = new Map<string, number>();
  const objects = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const r of roots) {
    const obj = repo.objects.get(r);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(r);
      const target = parseTagTarget(obj.data);
      if (target) queue.push({ oid: target, depth: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: r, depth: 1 });
    } else if (obj.type === 'tree') {
      collectTreeObjects(repo, r, objects);
    } else {
      objects.add(r);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const { oid, depth } = queue[qi++];
    if (commits.has(oid)) continue;
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    commits.set(oid, depth);
    objects.add(oid);
    const parsed = parseCommit(obj.data);
    collectTreeObjects(repo, parsed.tree, objects);
    if (opts.stopAt?.has(oid)) continue;
    for (const p of parsed.parents) queue.push({ oid: p, depth: depth + 1 });
  }
  return { commits, objects };
}

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth?: number,
): FetchPlan {
  const shallowSet = new Set(shallow);
  const have = walkCommits(repo, haves, { stopAt: shallowSet });
  const want = walkCommits(repo, wants, { maxDepth: depth });
  const sendOids = new Set<string>();
  for (const oid of want.objects) {
    if (!have.objects.has(oid)) sendOids.add(oid);
  }
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, gen] of want.commits) {
      if (gen !== depth) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !want.commits.has(p) && !have.commits.has(p))) newShallow.push(oid);
    }
  }
  for (const s of shallow) {
    if (!want.commits.has(s)) continue;
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => want.commits.has(p) || have.commits.has(p))) unshallow.push(s);
  }
  newShallow.sort();
  unshallow.sort();
  const objects: GitObject[] = [];
  for (const oid of [...sendOids].sort()) {
    const o = repo.objects.get(oid);
    if (o) objects.push(o);
  }
  return { objects, shallow: newShallow, unshallow };
}

/** Follow tag objects to the commit they point at. */
export function peelTag(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    const target = parseTagTarget(obj.data);
    if (!target) return current;
    current = target;
  }
  return current;
}

// ---------------------------------------------------------------- advertisements

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs in advertisement order: HEAD, branches, tags (peeled after tags). */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) out.push({ name: 'HEAD', oid: defaultTip });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (name.startsWith('refs/heads/')) out.push({ name, oid: repo.refs.get(name) as string });
  }
  for (const name of names) {
    if (!name.startsWith('refs/tags/')) continue;
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    const line: RefLine = { name, oid };
    if (obj && obj.type === 'tag') line.peeled = peelTag(repo, oid);
    out.push(line);
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine(`# service=${service}\n`));
  lines.push(pktFlush());
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const first = i === 0 ? `\0${caps}` : '';
      lines.push(pktLine(`${ref.oid} ${ref.name}${first}\n`));
      if (ref.peeled) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------- handlers

export interface GitHttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, obj: unknown): GitHttpResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

function getHeader(req: GitHttpRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Data-packet payloads as strings, in order, ignoring delim/flush markers. */
function dataLines(items: PktItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') out.push(item.payload.toString('utf8'));
  }
  return out;
}

/**
 * Handle a git smart-HTTP request. Returns a response when the path is a git
 * route for an existing repo, a 404 JSON when the repo is missing, or null
 * when the path is not a git route at all.
 */
export function handleGit(req: GitHttpRequest): GitHttpResponse | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(req.path);
  if (!match) return null;
  const [, owner, repoName, sub] = match;
  const repo = getRepo(owner, repoName);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });

  if (req.method === 'GET' && sub === 'info/refs') {
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return jsonResponse(404, { message: 'Not Found' });
    }
    const wantsV2 = service === 'git-upload-pack' && getHeader(req, 'git-protocol') === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body };
  }

  if (req.method === 'POST' && sub === 'git-upload-pack') {
    return handleUploadPack(req, repo);
  }

  if (req.method === 'POST' && sub === 'git-receive-pack') {
    return handleReceivePack(req, repo);
  }

  return jsonResponse(404, { message: 'Not Found' });
}

function handleUploadPack(req: GitHttpRequest, repo: Repo): GitHttpResponse {
  const isV2 = getHeader(req, 'git-protocol') === 'version=2';
  let first: PktItem[];
  let consumed: number;
  try {
    const decoded = decodePktLines(req.body);
    first = decoded.items;
    consumed = decoded.consumed;
  } catch (err) {
    return jsonResponse(400, { message: `malformed pkt-line: ${(err as Error).message}` });
  }
  const lines = dataLines(first);
  const command = (lines[0] ?? '').trim();
  if (isV2 || command.startsWith('command=')) {
    return handleUploadPackV2(repo, lines);
  }
  // v0: two flush-separated sections; decode the second from the remainder.
  let second: PktItem[] = [];
  if (consumed < req.body.length) {
    try {
      second = decodePktLines(req.body.subarray(consumed)).items;
    } catch (err) {
      return jsonResponse(400, { message: `malformed pkt-line: ${(err as Error).message}` });
    }
  }
  return handleUploadPackV0(repo, lines, dataLines(second));
}

function handleUploadPackV2(repo: Repo, lines: string[]): GitHttpResponse {
  const command = (lines[0] ?? '').trim();
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (defaultTip && symrefs && keep('HEAD')) {
      out.push(pktLine(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    if (!defaultTip && unborn && keep('HEAD')) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refLines(repo)) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
    out.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
    }
    const plan = computeFetch(repo, wants, haves, shallow, depth);
    const out: Buffer[] = [];
    out.push(pktLine('acknowledgments\n'));
    out.push(pktLine('NAK\n'));
    out.push(pktDelim());
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
      out.push(pktDelim());
    }
    if (plan.objects.length > 0) {
      out.push(pktLine('packfile\n'));
      out.push(sidebandPack(writePack(plan.objects)));
    }
    out.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
  }
  return jsonResponse(400, { message: `unknown v2 command ${JSON.stringify(command)}` });
}

function handleUploadPackV0(repo: Repo, firstSection: string[], secondSection: string[]): GitHttpResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of firstSection) {
    const t = line.trim();
    // The first want line may carry request capabilities after the oid; strip them.
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0].trim());
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
  }
  for (const line of secondSection) {
    const t = line.trim();
    if (t.startsWith('have ')) haves.push(t.slice(5).trim());
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const out: Buffer[] = [];
  out.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) out.push(sidebandPack(writePack(plan.objects)));
  out.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(req: GitHttpRequest, repo: Repo): GitHttpResponse {
  let items: PktItem[];
  let consumed: number;
  try {
    const decoded = decodePktLines(req.body);
    items = decoded.items;
    consumed = decoded.consumed;
  } catch (err) {
    return jsonResponse(400, { message: `malformed pkt-line: ${(err as Error).message}` });
  }
  const commands: PushCommand[] = [];
  for (const line of dataLines(items)) {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(clean);
    if (!m) return jsonResponse(400, { message: `bad push command ${JSON.stringify(clean.slice(0, 60))}` });
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  if (commands.length === 0) {
    return jsonResponse(400, { message: 'push needs at least one command' });
  }
  // The pack follows the command flush directly (absent for delete-only pushes).
  const packBytes = req.body.subarray(consumed);
  const reportLines: string[] = [];
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
      reportLines.push('unpack ok\n');
    } catch (err) {
      reportLines.push(`unpack ${(err as Error).message}\n`);
      const body = Buffer.concat([sidebandPack(encodePktLines(reportLines)), pktFlush()]);
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
    }
  } else {
    reportLines.push('unpack ok\n');
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    let ok = false;
    let reason = '';
    if (cmd.oldOid !== current) {
      reason = 'non-fast-forward';
    } else if (cmd.newOid === ZERO_OID) {
      if (current === ZERO_OID) reason = 'remote ref does not exist';
      else {
        repo.refs.delete(cmd.ref);
        ok = true;
      }
    } else {
      const target = repo.objects.get(cmd.newOid);
      if (!target) {
        reason = 'object not found';
      } else if (cmd.oldOid === ZERO_OID) {
        repo.refs.set(cmd.ref, cmd.newOid);
        ok = true;
      } else {
        // Fast-forward check: the old tip must be reachable from the new one.
        // Stop the moment the old tip is found: in a linear history it is the
        // new commit's parent, so a full-history walk would be O(n^2) over a
        // 200-push chain.
        let isFF = false;
        const stack: string[] = [cmd.newOid];
        const seen = new Set<string>();
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (oid === cmd.oldOid) {
            isFF = true;
            break;
          }
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          for (const p of parseCommit(obj.data).parents) stack.push(p);
        }
        if (isFF) {
          repo.refs.set(cmd.ref, cmd.newOid);
          ok = true;
        } else {
          reason = 'non-fast-forward';
        }
      }
    }
    reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  const body = Buffer.concat([sidebandPack(encodePktLines(reportLines)), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}
