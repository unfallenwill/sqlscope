// SQLite driver — zero external dependencies (node:sqlite, Node >= 22.5).
//
// Standard URL-form DSN (SQLAlchemy / DATABASE_URL convention):
//   sqlite:///app.db             relative path "app.db"
//   sqlite:////var/data/app.db   absolute path "/var/data/app.db"
//   sqlite:///:memory:           in-memory database
//   sqlite:////data/a.db?mode=ro      (read-only, handled centrally)
//
// Read-only enforcement is done by SQLite itself: the connection is opened
// with SQLITE_OPEN_READONLY, so mutations fail inside the engine regardless
// of what the SQL text looks like (covers triggers, PRAGMAs that write, ...).
//
// Statement routing (no grammar guessing):
//   1. scanner        — multiple top-level statements? -> exec() (script mode)
//   2. prepare+columns — row-returning statements expose result-column
//                        metadata at prepare time; write statements expose none
//   3. all() / run()  — chosen by the metadata above

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  DriverError,
  type DbConnection,
  type DbDriver,
  type DriverConfig,
  type IndexInfo,
  type QueryOptions,
  type QueryResult,
  type TableDescription,
  type TableSummary,
} from '../driver.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

/** Validate an identifier and quote it safely for embedding in SQL. */
function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new DriverError(
      `invalid identifier "${name}": expected letters, digits, _ and optional schema-qualified dots`,
    );
  }
  return name
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when the SQL contains more than one statement, counting only
 * top-level `;` outside comments and quoted literals/identifiers. Needed
 * because recent node:sqlite silently prepares multi-statement strings and
 * executes just the first one — unacceptable silent truncation.
 */
function isMultiStatement(sql: string): boolean {
  const skipComment = (i: number): number => {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < sql.length && sql[j] !== '\n') j++;
      return j;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      let j = i + 2;
      while (j < sql.length && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      return Math.min(j + 2, sql.length);
    }
    return i;
  };

  let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    if (quote !== '') {
      if (quote === '[') {
        if (ch === ']') quote = '';
      } else if (ch === quote) {
        if (sql[i + 1] === quote) i++; // escaped '' "" ``
        else quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch;
      continue;
    }
    if (ch === '-' || ch === '/') {
      const after = skipComment(i);
      if (after !== i) {
        i = after - 1;
        continue;
      }
    }
    if (ch === ';') {
      let j = i + 1;
      while (j < sql.length) {
        const c = sql[j] as string;
        if (/\s/.test(c)) {
          j++;
          continue;
        }
        const skipped = skipComment(j);
        if (skipped !== j) {
          j = skipped;
          continue;
        }
        return true; // real content follows the semicolon
      }
      return false; // trailing `;` / comments only
    }
  }
  return false;
}

// node:sqlite overloads are awkward for the positional/named split; go
// through untyped call signatures and rely on runtime validation instead.
type AllFn = (...args: unknown[]) => unknown[];
type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

function isPositional(params: unknown): boolean {
  return Array.isArray(params) || params === undefined || params === null;
}

class SqliteConnection implements DbConnection {
  readonly driver = 'sqlite';
  private closed = false;

  constructor(private readonly db: DatabaseSync) {}

  async query(sql: string, params: unknown, options: QueryOptions): Promise<QueryResult> {
    if (this.closed) throw new DriverError('connection is closed');
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new DriverError('sql must be a non-empty string');
    }
    if (!isPositional(params) && typeof params !== 'object') {
      throw new DriverError(
        'params must be an array (positional ?) or an object (named :name/$name/@name)',
      );
    }
    if (isMultiStatement(sql)) return this.execScript(sql, params);

    let stmt: StatementSync;
    try {
      stmt = this.db.prepare(sql);
    } catch (error) {
      throw new DriverError(`sqlite: ${errorMessage(error)}`);
    }

    // Statement routing without grammar guessing: row-returning statements
    // (SELECT / PRAGMA / EXPLAIN / CTE-SELECT) expose result-column metadata
    // at prepare time; write statements (DML/DDL) expose none. Bonus: the
    // metadata gives us column names even when zero rows come back.
    const columns = stmt
      .columns()
      .map((column) => String(column.column ?? column.name ?? ''))
      .filter((name) => name.length > 0);

    // node:sqlite methods are native — they must be invoked with the
    // statement as the receiver, hence .apply() instead of detached calls.
    if (columns.length > 0) {
      const raw = isPositional(params)
        ? (stmt.all as unknown as AllFn).apply(stmt, (params ?? []) as unknown[])
        : (stmt.all as unknown as AllFn).apply(stmt, [params]);
      const rows = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
      const truncated = rows.length > options.maxRows;
      return {
        kind: 'rows',
        columns,
        rows: truncated ? rows.slice(0, options.maxRows) : rows,
        rowCount: rows.length,
        truncated,
      };
    }

    try {
      const result = isPositional(params)
        ? (stmt.run as unknown as (...args: unknown[]) => RunResult).apply(stmt, (params ?? []) as unknown[])
        : (stmt.run as unknown as (...args: unknown[]) => RunResult).apply(stmt, [params]);
      const lastInsertRowid = Number(result.lastInsertRowid);
      return {
        kind: 'execution',
        changes: Number(result.changes),
        ...(Number.isSafeInteger(lastInsertRowid) && lastInsertRowid !== 0
          ? { lastInsertRowid }
          : {}),
      };
    } catch (error) {
      throw new DriverError(`sqlite: ${errorMessage(error)}`);
    }
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.fetchRows(
      `SELECT "name" AS name, "type" AS type, "ncol" AS columnCount
         FROM pragma_table_list
        WHERE schema = 'main'
          AND "type" IN ('table', 'view')
          AND "name" NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY "name"`,
    );
    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      columnCount: Number(row.columnCount),
    }));
  }

  async describeTable(table: string): Promise<TableDescription> {
    const columnRows = await this.fetchRows(
      `SELECT "name" AS name, "type" AS type, "notnull" AS "notNull",
              dflt_value AS defaultValue, "pk" AS pk
         FROM pragma_table_info(?)
        ORDER BY cid`,
      [table],
    );
    if (columnRows.length === 0) {
      throw new DriverError(`table "${table}" not found`);
    }

    const indexRows = await this.fetchRows(
      `SELECT il."name" AS name, il."unique" AS "unique", il.origin AS origin
         FROM pragma_index_list(?) il`,
      [table],
    );
    const indexes: IndexInfo[] = [];
    for (const indexRow of indexRows) {
      const indexName = String(indexRow.name);
      const columns = (
        await this.fetchRows(
          `SELECT ii."name" AS name FROM pragma_index_info(?) ii ORDER BY ii.seqno`,
          [indexName],
        )
      ).map((columnRow) => String(columnRow.name));
      indexes.push({
        name: indexName,
        unique: indexRow.unique === 1 || indexRow.unique === true,
        columns,
        origin: indexRow.origin === undefined ? undefined : String(indexRow.origin),
      });
    }

    const foreignKeys = (
      await this.fetchRows(
        `SELECT fk."table" AS refTable, fk."from" AS "from", fk."to" AS "to",
                fk.on_update AS "onUpdate", fk.on_delete AS "onDelete"
           FROM pragma_foreign_key_list(?) fk
          ORDER BY fk.id, fk.seq`,
        [table],
      )
    ).map((row) => ({
      column: String(row.from),
      referencesTable: String(row.refTable),
      referencesColumn: row.to === undefined || row.to === null ? null : String(row.to),
      onUpdate: row.onUpdate === undefined ? undefined : String(row.onUpdate),
      onDelete: row.onDelete === undefined ? undefined : String(row.onDelete),
    }));

    const createSqlRow = await this.fetchRows(
      `SELECT sql AS createSql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
      [table],
    );
    const countRow = await this.fetchRows(`SELECT COUNT(*) AS rowCount FROM ${quoteIdent(table)}`);

    return {
      table,
      columns: columnRows.map((row) => ({
        name: String(row.name),
        type: row.type === null || row.type === undefined || row.type === '' ? '' : String(row.type),
        notNull: row.notNull === 1 || row.notNull === true,
        defaultValue: row.defaultValue ?? null,
        primaryKey: Number(row.pk),
      })),
      indexes,
      foreignKeys,
      createSql: createSqlRow[0]?.createSql == null ? undefined : String(createSqlRow[0]?.createSql),
      rowCount: Number(countRow[0]?.rowCount ?? 0),
    };
  }

  async sampleRows(table: string, limit: number, options: QueryOptions): Promise<QueryResult> {
    const effective = Math.max(1, Math.min(limit, options.maxRows));
    return this.query(`SELECT * FROM ${quoteIdent(table)} LIMIT ?`, [effective], options);
  }

  async explainQuery(sql: string, params: unknown, options: QueryOptions): Promise<QueryResult> {
    // EXPLAIN QUERY PLAN only plans; it never executes the statement, so it
    // is safe on a read-only connection even for write statements.
    return this.query(`EXPLAIN QUERY PLAN ${sql}`, params, options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- internals -----------------------------------------------------------

  private async fetchRows(
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.query(sql, params, { readonly: false, maxRows: 100_000 });
    return result.kind === 'rows' ? result.rows : [];
  }

  private execScript(sql: string, params: unknown): QueryResult {
    if (Array.isArray(params) ? params.length > 0 : params != null) {
      throw new DriverError('multi-statement scripts cannot take params');
    }
    try {
      this.db.exec(sql);
      const statements = sql
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0).length;
      return { kind: 'exec', statements };
    } catch (error) {
      throw new DriverError(`sqlite: ${errorMessage(error)}`);
    }
  }
}

export const sqliteDriver: DbDriver = {
  name: 'sqlite',
  description: 'SQLite database via node:sqlite (local file or :memory:)',
  dsnExamples: ['sqlite:///app.db', 'sqlite:////var/data/app.db', 'sqlite:///:memory:'],
  parseDsn(dsn: string): DriverConfig {
    let url: URL;
    try {
      url = new URL(dsn);
    } catch {
      throw new DriverError(`invalid sqlite DSN "${dsn}"`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new DriverError('sqlite DSN cannot carry user/password');
    }
    if (url.host !== '') {
      throw new DriverError(`sqlite DSN cannot carry a host ("${url.host}"); use three slashes for a relative path or four for absolute`);
    }
    // Standard convention: exactly one leading slash separates the (empty)
    // authority from the path — "sqlite:///app.db" -> "app.db",
    // "sqlite:////a.db" -> "/a.db", "sqlite:///:memory:" -> ":memory:".
    if (!url.pathname.startsWith('/')) {
      throw new DriverError('sqlite DSN needs a path: sqlite:///app.db or sqlite:///:memory:');
    }
    let path = url.pathname.slice(1);
    try {
      path = decodeURIComponent(path);
    } catch {
      throw new DriverError(`sqlite DSN path has invalid percent-encoding: "${url.pathname}"`);
    }
    if (path.length === 0) {
      throw new DriverError('sqlite DSN path is empty: use sqlite:///app.db or sqlite:///:memory:');
    }
    return { path };
  },
  async open(config, options: QueryOptions) {
    const path = config.path;
    if (typeof path !== 'string' || path.length === 0) {
      throw new DriverError('sqlite config requires string "path"');
    }
    const readonly = config.readonly === true || options.readonly;
    try {
      return new SqliteConnection(new DatabaseSync(path, { readOnly: readonly }));
    } catch (error) {
      throw new DriverError(`cannot open sqlite database "${path}": ${errorMessage(error)}`);
    }
  },
};
