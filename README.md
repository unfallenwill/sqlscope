# SQLScope

**SQLScope** is a database query tool exposed as an [MCP](https://modelcontextprotocol.io) server, built for AI agents that need to *look into* real data: discover tables, understand schemas, sample rows, and run SQL — through five focused tools.

First release supports **SQLite** (zero-dependency `node:sqlite`) and **MySQL / MariaDB** (`mysql2`). The driver layer is small and typed, so PostgreSQL and friends slot in without touching the tool surface.

## Architecture

```
MCP client ──stdio / streamable HTTP──> SQLScope MCP server (this process)
                          │  connection table (opened at startup)
                          ├── sqlite connection  (node:sqlite)
                          ├── mysql connection   (mysql2/promise)
                          └── ...
```

- **Connections are operator-declared, never agent-created.** Databases are configured at startup via standard DSN URIs; the agent can only query what the operator exposed.
- **Read-only mode is engine-enforced.** SQLite connections open with `SQLITE_OPEN_READONLY`; MySQL sessions run `SET SESSION TRANSACTION READ ONLY`. In both cases mutations fail inside the database engine — not by SQL-text pattern matching, which triggers, PRAGMAs, and CTE-hidden writes would defeat.
- **Row caps protect the context window.** Row results are capped (`--max-rows`, default 1000, per-query override up to 100k) and flagged with `truncated: true` instead of silently flooding the model.
- **No guessing SQL grammar.** Statement routing uses engine metadata (SQLite result-column metadata at prepare time; MySQL field packets), and multi-statement scripts are detected by a real scanner so nothing is silently dropped.

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `list_tables` | `connection?` | Tables + views in the default schema, with column counts |
| `describe_table` | `table`, `connection?` | Columns (type, nullability, default, PK), indexes, foreign keys, CREATE DDL, row count |
| `sample_rows` | `table`, `limit?`, `connection?` | First N rows (default 10) to see real values |
| `query` | `sql`, `params?`, `connection?`, `maxRows?` | Run SQL: SELECT returns rows (capped), DML returns affected counts; multi-statement scripts where the driver allows |
| `explain_query` | `sql`, `params?`, `connection?` | Execution plan (EXPLAIN) without executing; safe on write statements |

Clients see them namespaced, e.g. `sqlscope.list_tables`. Errors come back as tool errors with the engine's message (connection failures, syntax errors, read-only violations), so agents can react instead of parsing stack traces.

## Usage

### Local

```bash
npm install
npm run build
node dist/index.js --db sqlite:///app.db
node dist/index.js --db 'mysql://user:pass@127.0.0.1:3306/shop'
```

Register with Claude Code:

```bash
claude mcp add sqlscope -- node /path/to/sqlscope/dist/index.js --db sqlite:///app.db --readonly
```

### Docker

```bash
docker build -t sqlscope .
docker run -i --rm \
  -e SQLSCOPE_DSN='sqlite:////data/app.db' \
  -v "$PWD/data:/data" \
  sqlscope
```

### Connections — one standard DSN format

Every connection is a standard RFC 3986 URI. Schemes follow each database's own conventions (SQLAlchemy/`DATABASE_URL` for SQLite, MySQL Shell/mysql2 for MySQL; a future PG driver will use libpq's `postgresql://`):

```
sqlite:///app.db               SQLite, relative path
sqlite:////var/data/app.db     SQLite, absolute path (four slashes)
sqlite:///:memory:             SQLite, in-memory
mysql://user:pass@host:3306/db MySQL / MariaDB
mariadb://user@host/db         alias for mysql
```

Append `?mode=ro` (the SQLite URI spec's read-only parameter, honored by every driver) to force a single connection read-only:

```
sqlite:////data/app.db?mode=ro
mysql://user@host/db?mode=ro
```

Other driver-specific params after `?` are passed through (e.g. `charset=utf8mb4` for mysql2).

Declaring connections:

| Where | Form | Notes |
|---|---|---|
| CLI | `--db <dsn>` | connection named `default`; repeatable |
| CLI | `--db <name>=<dsn>` | named, e.g. `--db analytics=mysql://u@h/db` |
| env | `SQLSCOPE_DSN='<dsn>'` | single connection (`default`) |
| env | `SQLSCOPE_CONNECTIONS='{"oltp":"mysql://u:p@h/db","cache":"sqlite:///a.db"}'` | JSON map for several |

### Server options

| Option | Env | Default | Notes |
|---|---|---|---|
| `--readonly` | `SQLSCOPE_READONLY=1` | off | Engine-enforced read-only on every connection (per-DSN `?mode=ro` ORs in) |
| `--max-rows <n>` | `SQLSCOPE_MAX_ROWS` | 1000 | Row cap; per-query override via the `query` tool |
| `--transport <stdio\|http>` | `MCP_TRANSPORT` | stdio | |
| `--host <address>` | `MCP_HOST` | 127.0.0.1 | HTTP mode |
| `--port <number>` | `MCP_PORT` / `PORT` | 3000 | HTTP mode |
| `--token <secret>` | `MCP_TOKEN` | none | Bearer auth for HTTP; **use whenever reachable beyond loopback** |

With more than one connection (and none named `default`), tools require the `connection` argument; the error message lists what is configured.

### Example session

```
list_tables {}                                                  # → users(3 cols), orders(5), ...
describe_table { "table": "users" }                             # columns, pk, indexes, DDL
sample_rows   { "table": "users", "limit": 3 }                  # real values
query         { "sql": "SELECT count(*) AS n FROM users WHERE team_id = ?", "params": [7] }
explain_query { "sql": "SELECT * FROM users WHERE email = 'a@b.c'" }   # index used? no table scan
```
## Design notes

- **Why startup-declared connections?** The agent never holds credentials or chooses targets; the operator pins exactly what is visible. This also makes SQLScope safe to run read-write against a staging database without giving the agent a footgun.
- **Statement routing.** SQLite: `StatementSync.columns()` exposes result columns at prepare time — row-returning statements are detected without executing or regex-matching; write statements route to `run()`. MySQL: the presence of field packets on the result discriminates rows from OkPacket. Multi-statement scripts (SQLite only) are routed to `exec()` by a scanner that respects quotes and comments — newer `node:sqlite` silently executes only the *first* statement of a multi-statement string, which we refuse to do.
- **JSON-safe results.** BIGINTs become numbers (strings when > 2^53), BLOBs become hex, DATETIMEs stay strings (`dateStrings: true` on mysql2) so agents always receive plain JSON.
- **Read-only is not a regex.** See *Architecture*. MySQL's read-only session blocks even temporary-table writes — that is the point.

### Limitations

- MySQL runs one connection per configured name; concurrent tool calls are queued by mysql2 (fine for agent workloads, not for analytics fan-out).
- Multi-statement scripts are SQLite-only; MySQL keeps `multipleStatements` off.
- `sample_rows` has no ORDER BY — it returns whatever the engine yields first.
- Row counts in `describe_table` are exact for SQLite (`COUNT(*)`) and omitted for MySQL (InnoDB estimates would lie).

## Development

```bash
npm run build
node scripts/smoke.mjs                    # stdio smoke, all 5 tools, readonly mode (19 assertions)

# MySQL integration (spins up nothing itself — point it at a disposable server):
docker run -d --rm --name sqlscope-mysql -e MYSQL_ROOT_PASSWORD=t -e MYSQL_DATABASE=t -p 127.0.0.1:33061:3306 mysql:8
TEST_MYSQL_URL='mysql://root:t@127.0.0.1:33061/t' node scripts/smoke-mysql.mjs

# HTTP transport check
node dist/index.js --db sqlite:///:memory: --transport http --port 3000 --token s3cret
```

Roadmap: PostgreSQL driver, per-connection `readonly` overrides, write-statement confirmation flow, query timeouts.

## License

MIT — see [LICENSE](LICENSE).
