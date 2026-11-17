// Hand-rolled GraphQL executor for the documents gh and github-mcp-server
// send, plus __type introspection. No schema validation beyond a static
// field table: unknown fields produce HTTP 200 + an errors array naming
// the field (the suite's invalid-field check requires exactly that).

import {
  store,
  getRepo,
  createIssue,
  createPull,
  mergePull,
  pullIsConflicted,
  diffPullFiles,
  globalId,
  decodeGlobalId,
  parseCommit,
  type Repo,
  type Issue,
  type Pull,
  type IssueComment,
} from './store.ts';
import { VIEWER, EPOCH_ISO } from './scenario.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  type: 'punct' | 'name' | 'string' | 'int' | 'float';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.type !== 'name') throw new Error(`expected a name, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek()) {
      const t = this.peek() as Token;
      if (t.type === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() });
      } else if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        doc.operations.push(this.parseOperation());
      } else if (t.type === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        doc.fragments.set(name, { typeCondition, selectionSet });
      } else {
        throw new Error(`unexpected token ${t.value} in GraphQL document`);
      }
    }
    return doc;
  }

  private parseOperation(): OperationNode {
    const kind = this.next().value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    const t = this.peek();
    if (t && t.type === 'name') name = this.next().value;
    const variableDefinitions = this.peek()?.value === '(' ? this.parseVariableDefinitions() : [];
    const selectionSet = this.parseSelectionSet();
    return { kind, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    this.expectPunct('(');
    while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      let defaultValue: ValueNode | null = null;
      if (this.peek()?.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  /** Skip a type expression: Name, [T], T!, etc. */
  private skipType(): void {
    const t = this.peek();
    if (!t) return;
    if (t.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.value === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.value === '...') {
      this.next();
      const t = this.peek();
      if (t?.type === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (t?.type === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek()?.value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.type === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.type === 'string') return { kind: 'string', value: t.value };
    if (t.type === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.type === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.type === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.type === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.type === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------- type table

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels', 'closedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'mergedAt', 'mergeCommit', 'author', 'headRef', 'baseRef'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const INTROSPECTED_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'mergedAt', 'mergeCommit', 'author', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Commit: ['oid', 'message'],
  Label: ['name', 'color', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- values

type GqlValue = Record<string, unknown> | null;

function userValue(): GqlValue {
  return { __typename: 'User', id: VIEWER.id, login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}

function commentValue(repo: Repo, issue: Issue, comment: IssueComment): GqlValue {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function pageInfoValue(hasNextPage: boolean, endCursor: string | null, hasPreviousPage = false, startCursor: string | null = null): GqlValue {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage, endCursor, startCursor };
}

function cursorFor(kind: string, value: string | number): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | null, kind: string): number | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [k, v] = raw.split(':');
    if (k !== kind) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

// ---------------------------------------------------------------- executor

interface ExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let items = repo.issues.slice();
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    items = items.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  items.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const afterNum = cursorNumber(typeof args.after === 'string' ? args.after : null, 'issue');
  if (afterNum !== null) {
    items = items.filter((i) => (direction === 'DESC' ? i.number < afterNum : i.number > afterNum));
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNextPage = items.length > page.length;
  const endCursor = page.length > 0 ? cursorFor('issue', page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? cursorFor('issue', page[0].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueValue(repo, i)),
    pageInfo: pageInfoValue(hasNextPage, endCursor, afterNum !== null, startCursor),
    totalCount: items.length,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const items = repo.pulls.slice().sort((a, b) => b.seq - a.seq);
  const afterNum = cursorNumber(typeof args.after === 'string' ? args.after : null, 'pr');
  const filtered = afterNum !== null ? items.filter((p) => p.number < afterNum) : items;
  const first = typeof args.first === 'number' ? args.first : filtered.length;
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const endCursor = page.length > 0 ? cursorFor('pr', page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? cursorFor('pr', page[0].number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullValue(repo, p)),
    pageInfo: pageInfoValue(hasNextPage, endCursor, afterNum !== null, startCursor),
    totalCount: filtered.length,
  };
}

function resolveField(parentType: string, parent: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  const fields = TYPE_FIELDS[parentType] ?? [];
  if (name !== '__typename' && !fields.includes(name)) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return undefined;
  }
  if (name === '__typename') return parentType;
  const args = resolveArgs(field, ctx);
  const repo = (parent as Record<string, unknown> | null)?.repo as Repo | undefined;

  if (parentType === 'Query') {
    if (name === 'viewer') return userValue();
    if (name === 'repository') {
      const owner = args.owner as string;
      const rname = args.name as string;
      const r = getRepo(owner, rname);
      return r ? repoValue(r) : null;
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const r = getRepo(decoded.parts[0], decoded.parts[1]);
        return r ? repoValue(r) : null;
      }
      if (decoded.kind === 'issue') {
        const r = findRepoById(Number(decoded.parts[0]));
        if (!r) return null;
        const issue = r.issues.find((i) => i.number === Number(decoded.parts[1]));
        return issue ? issueValue(r, issue) : null;
      }
      if (decoded.kind === 'pr') {
        const r = findRepoById(Number(decoded.parts[0]));
        if (!r) return null;
        const pull = r.pulls.find((p) => p.number === Number(decoded.parts[1]));
        return pull ? pullValue(r, pull) : null;
      }
      if (decoded.kind === 'comment') {
        const r = findRepoById(Number(decoded.parts[0]));
        if (!r) return null;
        for (const issue of r.issues) {
          const c = issue.comments.find((cc) => cc.id === Number(decoded.parts[1]));
          if (c) return commentValue(r, issue, c);
        }
        return null;
      }
      return null;
    }
    if (name === '__type') {
      const tname = String(args.name ?? '');
      if (INTROSPECTED_FIELDS[tname]) {
        return { __typename: '__Type', name: tname, kind: 'OBJECT', fields: INTROSPECTED_FIELDS[tname], enumValues: null };
      }
      if (ENUM_VALUES[tname]) {
        return { __typename: '__Type', name: tname, kind: 'ENUM', fields: null, enumValues: ENUM_VALUES[tname] };
      }
      return null;
    }
  }

  if (parentType === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'repo') return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      const r = getRepo(decoded.parts[0], decoded.parts[1]);
      if (!r) return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      try {
        const issue = createIssue(r, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return { __typename: 'CreateIssuePayload', issue: issueValue(r, issue), clientMutationId: input.clientMutationId ?? null };
      } catch {
        return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      }
    }
    if (name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'issue') return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      const r = findRepoById(Number(decoded.parts[0]));
      const issue = r?.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (!issue) return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      issue.state = 'closed';
      issue.restJson = null;
      return { __typename: 'CloseIssuePayload', issue: issueValue(r as Repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    if (name === 'createPullRequest') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'repo') return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      const r = getRepo(decoded.parts[0], decoded.parts[1]);
      if (!r) return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      try {
        const pull = createPull(r, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(r, pull), clientMutationId: input.clientMutationId ?? null };
      } catch {
        return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      }
    }
    if (name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'pr') return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      const r = findRepoById(Number(decoded.parts[0]));
      const pull = r?.pulls.find((p) => p.number === Number(decoded.parts[1]));
      if (!pull || !r) return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      try {
        mergePull(r, pull);
      } catch {
        // Already merged / conflicted: return the PR as-is.
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(r, pull), clientMutationId: input.clientMutationId ?? null };
    }
    if (name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'issue') return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: input.clientMutationId ?? null };
      const r = findRepoById(Number(decoded.parts[0]));
      const issue = r?.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (!issue || !r) return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: input.clientMutationId ?? null };
      const comment: IssueComment = { id: r.commentSeq++, body: String(input.body ?? '') };
      issue.comments.push(comment);
      issue.restJson = null;
      const node = commentValue(r, issue, comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node, cursor: cursorFor('comment', comment.id) },
        clientMutationId: input.clientMutationId ?? null,
      };
    }
  }

  if (parentType === 'User') {
    if (name === 'id') return globalId('user', VIEWER.login);
    if (name === 'login') return VIEWER.login;
    if (name === 'name') return VIEWER.name;
    if (name === 'email') return VIEWER.email;
    if (name === 'url') return `https://github.local/${VIEWER.login}`;
  }

  if (parentType === 'Repository' && repo) {
    if (name === 'id') return globalId('repo', repo.owner, repo.name);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return userValue();
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return { __typename: 'Ref', repo, name: repo.defaultBranch, oid: tip };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.private;
    if (name === 'createdAt' || name === 'updatedAt') return EPOCH_ISO;
    if (name === 'url') return `https://github.local/${repo.owner}/${repo.name}`;
    if (name === 'issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      return issue ? issueValue(repo, issue) : null;
    }
    if (name === 'issues') return issueConnection(repo, args);
    if (name === 'pullRequests') return pullConnection(repo, args);
    if (name === 'pullRequest') {
      const pull = repo.pulls.find((p) => p.number === Number(args.number));
      return pull ? pullValue(repo, pull) : null;
    }
  }

  if (parentType === 'Ref') {
    if (name === 'name') return (parent as Record<string, unknown>).name as string;
    if (name === 'target') {
      const oid = (parent as Record<string, unknown>).oid as string;
      return { __typename: 'Commit', repo, oid };
    }
  }

  if (parentType === 'Commit') {
    const oid = (parent as Record<string, unknown>).oid as string;
    if (name === 'oid') return oid;
    if (name === 'message') {
      const obj = repo?.objects.get(oid);
      if (!obj || obj.type !== 'commit') return '';
      return parseCommit(obj.data).message;
    }
  }

  if (parentType === 'Issue') {
    const issue = (parent as Record<string, unknown>).issue as Issue;
    if (name === 'id') return globalId('issue', repo?.id ?? 0, issue.number);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'createdAt' || name === 'updatedAt') return EPOCH_ISO;
    if (name === 'closedAt') return issue.state === 'closed' ? EPOCH_ISO : null;
    if (name === 'url') return `https://github.local/${repo?.owner}/${repo?.name}/issues/${issue.number}`;
    if (name === 'author') return userValue();
    if (name === 'labels') return issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color, description: l.description }));
    if (name === 'comments') {
      return {
        __typename: 'IssueCommentConnection',
        nodes: issue.comments.map((c) => commentValue(repo as Repo, issue, c)),
        pageInfo: pageInfoValue(false, null),
        totalCount: issue.comments.length,
      };
    }
  }

  if (parentType === 'IssueComment') {
    const comment = (parent as Record<string, unknown>).comment as IssueComment;
    const issue = (parent as Record<string, unknown>).issue as Issue;
    if (name === 'id') return globalId('comment', repo?.id ?? 0, comment.id);
    if (name === 'body') return comment.body;
    if (name === 'author') return userValue();
    if (name === 'createdAt') return EPOCH_ISO;
    void issue;
  }

  if (parentType === 'Label') {
    const label = parent as Record<string, unknown>;
    if (name === 'name') return label.name as string;
    if (name === 'color') return label.color as string;
    if (name === 'description') return (label.description as string) ?? '';
  }

  if (parentType === 'PullRequest') {
    const pull = (parent as Record<string, unknown>).pull as Pull;
    if (name === 'id') return globalId('pr', repo?.id ?? 0, pull.number);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return repo ? (pullIsConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
    if (name === 'headRefName') return pull.head;
    if (name === 'baseRefName') return pull.base;
    if (name === 'createdAt') return EPOCH_ISO;
    if (name === 'mergedAt') return pull.merged_at;
    if (name === 'mergeCommit') {
      if (!pull.merge_commit_sha) return null;
      return { __typename: 'Commit', repo, oid: pull.merge_commit_sha };
    }
    if (name === 'author') return userValue();
    if (name === 'headRef') return { __typename: 'Ref', repo, name: pull.head, oid: pull.headSha };
    if (name === 'baseRef') return { __typename: 'Ref', repo, name: pull.base, oid: pull.baseSha };
    if (name === 'files') {
      const files = repo ? diffPullFiles(repo, pull) : [];
      const first = typeof args.first === 'number' ? args.first : files.length;
      const page = files.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions, changes: f.changes })),
        pageInfo: pageInfoValue(files.length > page.length, null),
        totalCount: files.length,
      };
    }
  }

  if (parentType === 'PullRequestChangedFile') {
    const f = parent as Record<string, unknown>;
    if (name === 'path') return f.path as string;
    if (name === 'additions') return f.additions as number;
    if (name === 'deletions') return f.deletions as number;
    if (name === 'changes') return f.changes as number;
  }

  if (parentType === 'PageInfo') {
    const p = parent as Record<string, unknown>;
    if (name === 'hasNextPage') return p.hasNextPage as boolean;
    if (name === 'hasPreviousPage') return p.hasPreviousPage as boolean;
    if (name === 'endCursor') return p.endCursor as string | null;
    if (name === 'startCursor') return p.startCursor as string | null;
  }

  if (parentType === 'CommentEdge') {
    const e = parent as Record<string, unknown>;
    if (name === 'node') return e.node as GqlValue;
    if (name === 'cursor') return e.cursor as string;
  }

  if (parentType.endsWith('Payload')) {
    const p = parent as Record<string, unknown>;
    if (name === 'issue') return (p.issue as GqlValue) ?? null;
    if (name === 'pullRequest') return (p.pullRequest as GqlValue) ?? null;
    if (name === 'commentEdge') return (p.commentEdge as GqlValue) ?? null;
    if (name === 'clientMutationId') return (p.clientMutationId as string | null) ?? null;
  }

  if (parentType === '__Type') {
    const t = parent as Record<string, unknown>;
    if (name === 'name') return t.name as string;
    if (name === 'kind') return t.kind as string;
    if (name === 'description') return null;
    if (name === 'fields') {
      const list = t.fields as string[] | null;
      if (!list) return null;
      return list.map((n) => ({ __typename: '__Field', name: n }));
    }
    if (name === 'enumValues') {
      const list = t.enumValues as string[] | null;
      if (!list) return null;
      return list.map((n) => ({ __typename: '__EnumValue', name: n }));
    }
  }

  if (parentType === '__Field' || parentType === '__EnumValue' || parentType === '__InputValue') {
    const f = parent as Record<string, unknown>;
    if (name === 'name') return f.name as string;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    if (name === 'type') return null;
    if (name === 'args') return [];
    if (name === 'defaultValue') return null;
  }

  // Connection nodes/pageInfo/totalCount (generic over the connection value).
  if (parentType.endsWith('Connection')) {
    const c = parent as Record<string, unknown>;
    if (name === 'nodes') return c.nodes as GqlValue[];
    if (name === 'pageInfo') return c.pageInfo as GqlValue;
    if (name === 'totalCount') return c.totalCount as number;
  }

  return null;
}

function executeSelectionSet(
  selections: SelectionNode[],
  parentType: string,
  parent: GqlValue,
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      const nested = executeSelectionSet(frag.selectionSet, parentType, parent, ctx);
      if (nested) Object.assign(out, nested);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      const typename = (parent as Record<string, unknown>).__typename as string | undefined;
      if (sel.typeCondition && sel.typeCondition !== typename) continue;
      const nested = executeSelectionSet(sel.selectionSet, sel.typeCondition ?? parentType, parent, ctx);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(parentType, parent, sel, ctx);
    if (value === undefined) continue; // unknown field: error already recorded
    if (value === null || typeof value !== 'object') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      // A list of objects with a selection set (e.g. __Type.fields).
      if (sel.selectionSet) {
        const itemType = value.length > 0 ? ((value[0] as Record<string, unknown>).__typename as string) : 'Unknown';
        out[key] = value.map((item) => executeSelectionSet(sel.selectionSet as SelectionNode[], itemType, item as GqlValue, ctx));
      } else {
        out[key] = value;
      }
      continue;
    }
    if (sel.selectionSet) {
      const typename = (value as Record<string, unknown>).__typename as string;
      out[key] = executeSelectionSet(sel.selectionSet, typename, value as GqlValue, ctx);
    } else {
      // An object field without a selection set: never serialize internals.
      out[key] = null;
    }
  }
  return out;
}

function executeOperation(
  doc: DocumentNode,
  operationName: string | null,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { variables: {}, errors: [], fragments: doc.fragments };
  let op: OperationNode | undefined;
  if (operationName) op = doc.operations.find((o) => o.name === operationName);
  if (!op) op = doc.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation in document.' }] };
  for (const def of op.variableDefinitions) {
    if (Object.prototype.hasOwnProperty.call(variables, def.name)) {
      ctx.variables[def.name] = variables[def.name];
    } else if (def.defaultValue) {
      ctx.variables[def.name] = resolveValue(def.defaultValue, {});
    } else {
      ctx.variables[def.name] = null;
    }
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __typename: rootType };
  let data: Record<string, unknown> | null;
  try {
    data = executeSelectionSet(op.selectionSet, rootType, root, ctx);
  } catch (err) {
    ctx.errors.push({ message: (err as Error).message });
    data = null;
  }
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Execute one GraphQL request body (single operation or a JSON array batch). */
export function handleGraphQL(body: Buffer): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Request body is not valid JSON.' }] }) };
  }
  const runOne = (item: unknown): unknown => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { errors: [{ message: 'Invalid GraphQL request.' }] };
    }
    const req = item as Record<string, unknown>;
    const query = typeof req.query === 'string' ? req.query : '';
    const variables = (req.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof req.operationName === 'string' ? req.operationName : null;
    let doc: DocumentNode;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: (err as Error).message }] };
    }
    return executeOperation(doc, operationName, variables);
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: JSON.stringify(parsed.map(runOne)) };
  }
  return { status: 200, body: JSON.stringify(runOne(parsed)) };
}
