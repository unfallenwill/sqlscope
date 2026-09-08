#!/usr/bin/env node
// SQLScope — an MCP server that lets AI agents inspect and query databases.
//
// First release: SQLite (node:sqlite, zero deps) and MySQL / MariaDB (mysql2).
//
// Tools: list_tables / describe_table / sample_rows / query / explain_query
//
// Connections are standard RFC 3986 DSNs, declared at startup (never by the
// agent):
//   --db sqlite:///app.db              connection "default"
//   --db analytics=mysql://u:p@h/db    named connection (repeat --db freely)
//   env SQLSCOPE_DSN                   single connection ("default")
//   env SQLSCOPE_CONNECTIONS           JSON {"name": "dsn", ...} for several
//   Any DSN may append ?mode=ro (SQLite URI spec) to force read-only.
//
// Transports:
//   stdio (default)  node dist/index.js --db sqlite:///app.db
//   streamable HTTP  node dist/index.js --transport http [--host H] [--port P] [--token T]
//
// In HTTP mode each request is served by a fresh McpServer instance built by
// the same factory; connections live in the process-wide ConnectionManager,
// so state is shared across requests.

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import process from 'node:process';
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { ConnectionManager, CONNECTION_NAME_RE } from './connections.js';
import { sqliteDriver } from './drivers/sqlite.js';
import { mysqlDriver } from './drivers/mysql.js';
import { buildServer } from './server.js';

const SERVER_VERSION = '0.1.1';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Options {
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  token: string | undefined;
  readonly: boolean;
  maxRows: number;
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Collect connection declarations, in priority order:
 *   1. SQLSCOPE_CONNECTIONS — JSON map {"name": "dsn"}
 *   2. SQLSCOPE_DSN — single DSN, connection "default"
 *   3. --db [<name>=]<dsn> — repeatable; without a name, "default"
 *
 * A `name=` prefix is only treated as a name when it is a valid connection
 * name (no : / @ ? etc.), so DSNs with query params are never split.
 */
function loadConnectionDeclarations(dbs: string[]): Map<string, string> {
  const declarations = new Map<string, string>();

  const json = process.env.SQLSCOPE_CONNECTIONS;
  if (json !== undefined && json !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('SQLSCOPE_CONNECTIONS is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('SQLSCOPE_CONNECTIONS must be a JSON object of {"name": "dsn"}');
    }
    for (const [name, dsn] of Object.entries(parsed)) {
      if (typeof dsn !== 'string' || dsn.length === 0) {
        throw new Error(`SQLSCOPE_CONNECTIONS["${name}"] must be a DSN string`);
      }
      if (declarations.has(name)) throw new Error(`connection "${name}" declared twice`);
      declarations.set(name, dsn);
    }
  }

  const envDsn = process.env.SQLSCOPE_DSN;
  if (envDsn !== undefined && envDsn !== '') {
    if (declarations.has('default')) throw new Error('connection "default" declared twice');
    declarations.set('default', envDsn);
  }

  for (const declaration of dbs) {
    if (declaration.length === 0) throw new Error('--db needs a DSN, e.g. --db sqlite:///app.db');
    const eq = declaration.indexOf('=');
    const prefix = eq === -1 ? undefined : declaration.slice(0, eq);
    const [name, dsn] =
      prefix !== undefined && CONNECTION_NAME_RE.test(prefix)
        ? [prefix, declaration.slice(eq + 1)]
        : ['default', declaration];
    if (dsn.length === 0) throw new Error(`--db "${name}=" needs a DSN after "="`);
    if (declarations.has(name)) throw new Error(`connection "${name}" declared twice`);
    declarations.set(name, dsn);
  }

  return declarations;
}

const USAGE = `sqlscope ${SERVER_VERSION} — MCP database query tool (SQLite & MySQL)

Usage:
  sqlscope [options]

Connections — standard DSNs, declared by the operator (never by the agent):
  --db <dsn>              Declare a connection (repeatable):
                            sqlite:///app.db              relative path
                            sqlite:////var/data/app.db    absolute path
                            sqlite:///:memory:            in-memory
                            mysql://user:pass@host:3306/db
                            mariadb://user@host/db        (alias)
  --db <name>=<dsn>       Named connection, e.g. --db analytics=mysql://u@h/db
  Append ?mode=ro to any DSN to force that connection read-only.

  env SQLSCOPE_DSN          Single DSN (connection "default")
  env SQLSCOPE_CONNECTIONS  JSON for multiple: '{"oltp":"mysql://u:p@h/db","cache":"sqlite:///a.db"}'

Query behavior:
  --readonly             Reject anything that can mutate data (engine-side);
                         env SQLSCOPE_READONLY=1
  --max-rows <n>         Row cap per query (default 1000);
                         env SQLSCOPE_MAX_ROWS

Transports:
  --transport <stdio|http>  Transport to serve (default: stdio; env MCP_TRANSPORT)
  --host <address>          HTTP bind address (default: 127.0.0.1; env MCP_HOST)
  --port <number>           HTTP port (default: 3000; env MCP_PORT or PORT)
  --token <secret>          Require this bearer token for HTTP requests
                            (env MCP_TOKEN). Required for non-loopback binds.
  -h, --help                Show this help

Examples:
  sqlscope --db sqlite:///app.db
  sqlscope --db 'mysql://user:pass@127.0.0.1/shop' --readonly --max-rows 100
  sqlscope --db sqlite:///app.db --db analytics=mysql://u:p@h/db
  sqlscope --db sqlite:///app.db --transport http --port 3000 --token s3cret
`;

interface ParsedArgs {
  options: Options;
  dbs: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const dbs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq === -1 ? '' : arg.slice(eq + 1);
    if (eq === -1 && argv[i + 1] !== undefined && !((argv[i + 1] as string).startsWith('--'))) {
      value = argv[++i] as string;
    }
    if (key === 'db') {
      dbs.push(value);
      continue;
    }
    flags.set(key, value);
  }

  const transport = flags.get('transport') ?? process.env.MCP_TRANSPORT ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`invalid --transport "${transport}" (expected "stdio" or "http")`);
  }

  const portRaw = flags.get('port') ?? process.env.MCP_PORT ?? process.env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port "${portRaw}"`);
  }

  const token = flags.get('token') ?? process.env.MCP_TOKEN;

  const maxRowsRaw = flags.get('max-rows') ?? process.env.SQLSCOPE_MAX_ROWS;
  const maxRows = maxRowsRaw === undefined ? 1000 : Number(maxRowsRaw);
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100_000) {
    throw new Error(`invalid --max-rows "${maxRowsRaw}" (1..100000)`);
  }

  return {
    dbs,
    options: {
      transport,
      host: flags.get('host') ?? process.env.MCP_HOST ?? '127.0.0.1',
      port,
      token: token === '' ? undefined : token,
      readonly: flags.has('readonly') || truthy(process.env.SQLSCOPE_READONLY),
      maxRows,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function staticTokenVerifier(token: string): OAuthTokenVerifier {
  const expected = Buffer.from(token, 'utf8');
  return {
    async verifyAccessToken(candidate: string): Promise<AuthInfo> {
      const given = Buffer.from(candidate, 'utf8');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown or invalid token');
      }
      return {
        token: candidate,
        clientId: 'token-holder',
        scopes: [],
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    },
  };
}

async function runHttp(manager: ConnectionManager, opts: Options): Promise<() => Promise<void>> {
  const handler = createMcpHandler(() => buildServer(manager), {
    onerror: (error) => console.error('mcp handler error:', error?.message ?? error),
  });
  const serve = toNodeHandler(handler, {
    onerror: (error) => console.error('http adapter error:', error?.message ?? error),
  });

  // Loopback binds get the SDK's DNS-rebinding guards (they answer with 403
  // themselves). Non-loopback binds skip them: the Host/Origin values are
  // operator-chosen there, and token auth is the real boundary.
  const loopback = LOOPBACK_HOSTS.has(opts.host);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const verifier = opts.token === undefined ? undefined : staticTokenVerifier(opts.token);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (loopback && (!validateHost(req, res) || !validateOrigin(req, res))) return;
      if (verifier !== undefined) {
        try {
          (req as IncomingMessage & { auth?: AuthInfo }).auth = await verifyBearerToken(
            req.headers.authorization,
            { verifier },
          );
        } catch (error) {
          const challenge = bearerAuthChallengeResponse(error);
          const body = await challenge.text();
          res.writeHead(challenge.status, Object.fromEntries([...challenge.headers]));
          res.end(body);
          return;
        }
      }
      await serve(req, res);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });

  console.error(`sqlscope MCP server listening on http://${opts.host}:${opts.port}/mcp (transport: http)`);
  if (!loopback && verifier === undefined) {
    console.error(
      'warning: bound to a non-loopback address without --token; use a bearer token unless the port is otherwise protected',
    );
  }

  return async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await handler.close();
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dbs, options: opts } = parseArgs(process.argv.slice(2));

  const declarations = loadConnectionDeclarations(dbs);
  if (declarations.size === 0) {
    process.stderr.write('error: no connections configured\n\n');
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const manager = new ConnectionManager({ readonly: opts.readonly, maxRows: opts.maxRows });
  manager.registerDriver(sqliteDriver);
  manager.registerDriver(mysqlDriver);

  for (const [name, dsn] of declarations) {
    try {
      const info = await manager.connect(name, dsn);
      console.error(`connected: "${info.name}" (driver: ${info.driver})`);
    } catch (error) {
      console.error(
        `fatal: connection "${name}" failed:`,
        error instanceof Error ? error.message : error,
      );
      await manager.disconnectAll();
      process.exit(1);
    }
  }
  console.error(
    `sqlscope ready — ${declarations.size} connection(s), readonly: ${opts.readonly ? 'on' : 'off'}, maxRows: ${opts.maxRows}`,
  );

  let shutdown: (() => Promise<void>) | undefined;
  if (opts.transport === 'http') {
    shutdown = await runHttp(manager, opts);
  } else {
    const server: McpServer = buildServer(manager);
    await server.connect(new StdioServerTransport());
    console.error('sqlscope MCP server running on stdio');
  }

  let exiting = false;
  const exit = async () => {
    if (exiting) return;
    exiting = true;
    await shutdown?.();
    await manager.disconnectAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void exit());
  process.on('SIGTERM', () => void exit());
}

main().catch((error) => {
  console.error('fatal:', error);
  process.exit(1);
});
