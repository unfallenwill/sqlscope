// Smoke test: drives the SQLScope MCP server over stdio with raw JSON-RPC and
// asserts the behavior of all five tools plus readonly mode.
//
//   node scripts/smoke.mjs
//
// Uses an in-memory SQLite database; MySQL paths are exercised in
// integration with a live server (see README).
import { spawn } from 'node:child_process';

const serverCmd = process.env.SMOKE_CMD ?? process.execPath;
const serverArgs = process.env.SMOKE_ARGS ? process.env.SMOKE_ARGS.split(' ') : ['dist/index.js'];

let passed = 0;
let failed = 0;
function assert(condition, label, extra) {
  if (condition) {
    passed++;
    console.log(`  ok - ${label}`);
  } else {
    failed++;
    console.log(`  not ok - ${label}${extra !== undefined ? ` :: ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
}

function startServer(args) {
  const server = spawn(serverCmd, [...serverArgs, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  server.stdout.setEncoding('utf8');

  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };

  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    const text = response?.result?.content?.[0]?.text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { isError: response?.result?.isError === true, result: parsed, raw: response };
  };

  const stop = () =>
    new Promise((resolve) => {
      server.on('exit', resolve);
      server.kill();
    });

  return { request, call, stop };
}

// ---------------------------------------------------------------------------

console.log('# sqlscope smoke (stdio, sqlite :memory:)');
const server = startServer(['--db', 'sqlite:///:memory:']);

const init = await server.request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.0' },
});
assert(init?.result?.serverInfo?.name === 'sqlscope', 'initialize returns server name "sqlscope"', init?.result);

const tools = await server.request('tools/list', {});
const toolNames = (tools?.result?.tools ?? []).map((t) => t.name).sort();
assert(
  JSON.stringify(toolNames) ===
    JSON.stringify(['describe_table', 'explain_query', 'list_tables', 'query', 'sample_rows']),
  'exposes exactly the 5 tools',
  toolNames,
);

const ddl = await server.call('query', {
  sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE)',
});
assert(ddl.result?.kind === 'execution', 'query: CREATE TABLE executes', ddl);

let inserted = 0;
for (const [name, email] of [
  ['alice', 'alice@example.com'],
  ['bob', 'bob@example.com'],
  ['carol', 'carol@example.com'],
]) {
  const r = await server.call('query', {
    sql: 'INSERT INTO users (name, email) VALUES (?, ?)',
    params: [name, email],
  });
  inserted += r.result?.changes ?? 0;
}
assert(inserted === 3, 'query: 3 INSERTs report changes=3');

const multi = await server.call('query', {
  sql: 'UPDATE users SET name = name; DELETE FROM users WHERE id > 3;',
});
assert(multi.result?.kind === 'exec' && multi.result?.statements === 2, 'query: multi-statement script', multi);

const listed = await server.call('list_tables', {});
assert(
  listed.result?.tables?.some((t) => t.name === 'users' && t.columnCount === 3 && t.type === 'table'),
  'list_tables: shows users with 3 columns',
  listed,
);

const described = await server.call('describe_table', { table: 'users' });
assert(
  described.result?.columns?.length === 3 && described.result.columns[0].primaryKey === 1,
  'describe_table: 3 columns, id is pk',
  described,
);
assert(described.result?.indexes?.some((i) => i.columns.includes('email')), 'describe_table: unique email index', described);
assert(typeof described.result?.rowCount === 'number' && described.result.rowCount === 3, 'describe_table: rowCount=3');
assert(/CREATE TABLE users/.test(described.result?.createSql ?? ''), 'describe_table: includes DDL');
const missing = await server.call('describe_table', { table: 'nope' });
assert(missing.isError && /not found/.test(missing.result?.error ?? ''), 'describe_table: unknown table errors');

const sampled = await server.call('sample_rows', { table: 'users', limit: 2 });
assert(
  sampled.result?.kind === 'rows' && sampled.result.rowCount === 2 && sampled.result.columns.includes('email'),
  'sample_rows: returns 2 rows with columns',
  sampled,
);

const filtered = await server.call('query', {
  sql: 'SELECT id, name FROM users WHERE id >= ? ORDER BY id',
  params: [2],
});
assert(
  filtered.result?.kind === 'rows' && filtered.result.rowCount === 2 && filtered.result.rows[0].name === 'bob',
  'query: positional params bind',
  filtered,
);

const capped = await server.call('query', { sql: 'SELECT * FROM users', maxRows: 2 });
assert(capped.result?.truncated === true && capped.result.rows.length === 2, 'query: maxRows truncates', capped);

const explained = await server.call('explain_query', {
  sql: 'SELECT * FROM users WHERE email = ?',
  params: ['bob@example.com'],
});
const detail = JSON.stringify(explained.result ?? '');
assert(explained.result?.kind === 'rows' && /USING INDEX/.test(detail), 'explain_query: shows index usage', explained);

const badConn = await server.call('query', { sql: 'SELECT 1', connection: 'nope' });
assert(badConn.isError && /does not exist/.test(badConn.result?.error ?? ''), 'unknown connection errors clearly');

const badSql = await server.call('query', { sql: 'SELECT FROM WHERE' });
assert(badSql.isError && /sqlite/i.test(badSql.result?.error ?? ''), 'syntax error surfaces as tool error');

await server.stop();

console.log('# readonly mode (--readonly flag)');
const ro = startServer(['--db', 'sqlite:///:memory:', '--readonly']);
await ro.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } });
const roWrite = await ro.call('query', { sql: 'CREATE TABLE t(x)' });
assert(roWrite.isError && /readonly/i.test(roWrite.result?.error ?? ''), 'readonly: write rejected by the engine', roWrite);
const roRead = await ro.call('query', { sql: 'SELECT 1 AS one' });
assert(roRead.result?.rows?.[0]?.one === 1, 'readonly: reads still work', roRead);
await ro.stop();

console.log('# readonly mode (?mode=ro in DSN)');
const roDsn = startServer(['--db', 'sqlite:///:memory:?mode=ro']);
await roDsn.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } });
const roDsnWrite = await roDsn.call('query', { sql: 'CREATE TABLE t(x)' });
assert(roDsnWrite.isError && /readonly/i.test(roDsnWrite.result?.error ?? ''), 'mode=ro: write rejected', roDsnWrite);
const roDsnRead = await roDsn.call('query', { sql: 'SELECT 2 AS two' });
assert(roDsnRead.result?.rows?.[0]?.two === 2, 'mode=ro: reads still work', roDsnRead);
await roDsn.stop();

console.log('# named + multiple connections');
const multiServer = startServer(['--db', 'mem1=sqlite:///:memory:', '--db', 'mem2=sqlite:///:memory:']);
await multiServer.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } });
const ambiguous = await multiServer.call('list_tables', {});
assert(ambiguous.isError && /pass "connection"/.test(ambiguous.result?.error ?? ''), 'ambiguous connection errors', ambiguous);
const explicit = await multiServer.call('query', { sql: 'SELECT 9 AS v', connection: 'mem2' });
assert(explicit.result?.rows?.[0]?.v === 9 && explicit.result?.connection === 'mem2', 'explicit connection routing works', explicit);
await multiServer.stop();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
