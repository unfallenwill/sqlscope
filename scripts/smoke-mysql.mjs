// Integration smoke test: drives the SQLScope MCP server against a live MySQL.
//
//   TEST_MYSQL_URL='mysql://user:pass@127.0.0.1:33061/db' node scripts/smoke-mysql.mjs
//
// Creates and cleans up a table named `sqlscope_smoke` in the target database.
import { spawn } from 'node:child_process';

const MYSQL_URL = process.env.TEST_MYSQL_URL;
if (!MYSQL_URL) {
  console.error('set TEST_MYSQL_URL (e.g. mysql://root:pass@127.0.0.1:33061/sqlscope_test)');
  process.exit(1);
}

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

const server = spawn(process.execPath, ['dist/index.js', '--db', MYSQL_URL], {
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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
};

const call = async (name, args) => {
  const response = await request('tools/call', { name, arguments: args });
  let parsed;
  try {
    parsed = JSON.parse(response?.result?.content?.[0]?.text);
  } catch {
    parsed = undefined;
  }
  return { isError: response?.result?.isError === true, result: parsed };
};

const stop = () =>
  new Promise((resolve) => {
    server.on('exit', resolve);
    server.kill();
  });

// ---------------------------------------------------------------------------

console.log('# sqlscope mysql integration smoke');

await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-mysql', version: '0.0.0' },
});

await call('query', { sql: 'DROP TABLE IF EXISTS sqlscope_smoke' });
const ddl = await call('query', {
  sql: 'CREATE TABLE sqlscope_smoke (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64) NOT NULL, team_id INT, KEY idx_team (team_id))',
});
assert(ddl.result?.kind === 'execution', 'create table', ddl);

const ins = await call('query', {
  sql: 'INSERT INTO sqlscope_smoke (name, team_id) VALUES (?, ?)',
  params: ['alice', 1],
});
assert(ins.result?.kind === 'execution' && ins.result.changes === 1 && ins.result.lastInsertRowid === 1, 'insert reports changes + insertId', ins);

const listed = await call('list_tables', {});
const table = listed.result?.tables?.find((t) => t.name === 'sqlscope_smoke');
assert(table && table.type === 'table' && table.columnCount === 3, 'list_tables sees the table (3 columns)', listed);

const described = await call('describe_table', { table: 'sqlscope_smoke' });
assert(described.result?.columns?.length === 3, 'describe_table columns', described);
assert(described.result?.columns?.some((c) => c.name === 'id' && c.primaryKey === true), 'describe_table pk');
assert(described.result?.indexes?.some((i) => i.name === 'idx_team' && !i.unique), 'describe_table secondary index', described);
assert(/CREATE TABLE .sqlscope_smoke/i.test(described.result?.createSql ?? ''), 'describe_table DDL');

const sampled = await call('sample_rows', { table: 'sqlscope_smoke', limit: 5 });
assert(sampled.result?.kind === 'rows' && sampled.result.rowCount === 1 && sampled.result.rows[0].name === 'alice', 'sample_rows', sampled);

const selected = await call('query', { sql: 'SELECT id, name FROM sqlscope_smoke WHERE team_id = ?', params: [1] });
assert(selected.result?.kind === 'rows' && selected.result.rowCount === 1, 'query with params', selected);

const explained = await call('explain_query', { sql: 'SELECT * FROM sqlscope_smoke WHERE team_id = 1' });
const plan = JSON.stringify(explained.result ?? '');
assert(explained.result?.kind === 'rows' && /idx_team/.test(plan), 'explain_query uses index', explained);

const dbName = decodeURIComponent(new URL(MYSQL_URL).pathname.replace(/^\//, ''));
const schemaQualified = await call('sample_rows', { table: `${dbName}.sqlscope_smoke`, limit: 1 });
assert(schemaQualified.result?.kind === 'rows' && schemaQualified.result.rowCount === 1, 'schema-qualified table name', schemaQualified);

await call('query', { sql: 'DROP TABLE sqlscope_smoke' });
const afterDrop = await call('list_tables', {});
assert(!afterDrop.result?.tables?.some((t) => t.name === 'sqlscope_smoke'), 'cleanup drop');

await stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
