// MySQL driver — mysql2/promise (pure JS, no native deps).
//
// Standard URL-form DSN (MySQL Shell / mysql2 conventions, RFC 3986):
//   mysql://user:password@host:3306/dbname
//   mariadb://user@host/db          (alias, normalized to mysql://)
//   mysql://user@host/db?charset=utf8mb4&ssl=true   (driver params pass through)
//   ...?mode=ro                     (read-only, handled centrally)
//
// The DSN is handed to mysql2 as its documented `uri` option after central
// params are stripped; mysql2's own URI semantics apply to the rest.
//
// Read-only enforcement is engine-side: the session is switched to
// `SET SESSION TRANSACTION READ ONLY`, so any mutation fails in the server
// regardless of SQL text.
//
// One connection per configured name; mysql2 serializes queries on a single
// connection internally, so concurrent tool calls are queued safely.

import { createConnection, type Connection } from 'mysql2/promise';
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

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new DriverError(
      `invalid identifier "${name}": expected letters, digits, _ and optional schema-qualified dots`,
    );
  }
  return name
    .split('.')
    .map((part) => '`' + part + '`')
    .join('.');
}

interface FieldLike {
  name: string | Buffer;
}

interface OkLike {
  affectedRows?: number;
  insertId?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code !== undefined && code !== 'ER_UNKNOWN_ERROR' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

class MysqlConnection implements DbConnection {
  readonly driver = 'mysql';

  constructor(
    private readonly conn: Connection,
    /** Default schema (needed by the introspection tools). */
    private readonly database: string | undefined,
  ) {}

  private requireDatabase(operation: string): string {
    if (this.database === undefined) {
      throw new DriverError(
        `${operation} needs a default database; the DSN must include one (mysql://user@host/dbname)`,
      );
    }
    return this.database;
  }

  async query(sql: string, params: unknown, options: QueryOptions): Promise<QueryResult> {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new DriverError('sql must be a non-empty string');
    }
    if (!Array.isArray(params) && params !== undefined && params !== null && typeof params !== 'object') {
      throw new DriverError('params must be an array (positional ?) or an object (named, with namedPlaceholders)');
    }

    let raw: [unknown, FieldLike[] | undefined];
    try {
      raw = (await this.conn.query(sql, (params ?? []) as never)) as unknown as [unknown, FieldLike[] | undefined];
    } catch (error) {
      throw new DriverError(`mysql: ${errorMessage(error)}`);
    }
    const [result, fields] = raw;

    // fields is present exactly for statements that return rows
    // (SELECT / SHOW / EXPLAIN / DESCRIBE / ...).
    if (fields !== undefined && Array.isArray(result)) {
      const rows = result as Array<Record<string, unknown>>;
      const columns = fields.map((field) => String(field.name));
      const truncated = rows.length > options.maxRows;
      return {
        kind: 'rows',
        columns,
        rows: truncated ? rows.slice(0, options.maxRows) : rows,
        rowCount: rows.length,
        truncated,
      };
    }

    const ok = (result ?? {}) as OkLike;
    const insertId = typeof ok.insertId === 'number' && ok.insertId > 0 ? ok.insertId : undefined;
    return {
      kind: 'execution',
      changes: typeof ok.affectedRows === 'number' ? ok.affectedRows : 0,
      ...(insertId !== undefined ? { lastInsertRowid: insertId } : {}),
    };
  }

  async listTables(): Promise<TableSummary[]> {
    const db = this.requireDatabase('list_tables');
    const rows = (
      await this.fetchRows(
        `SELECT t.TABLE_NAME AS name,
                CASE t.TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' ELSE 'view' END AS type,
                COUNT(c.COLUMN_NAME) AS columnCount
           FROM information_schema.TABLES t
           LEFT JOIN information_schema.COLUMNS c
                  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
          WHERE t.TABLE_SCHEMA = ?
          GROUP BY t.TABLE_NAME, t.TABLE_TYPE
          ORDER BY t.TABLE_NAME`,
        [db],
      )
    ).map((row) => ({
      name: String(row.name),
      type: String(row.type),
      columnCount: Number(row.columnCount),
    }));
    return rows;
  }

  async describeTable(table: string): Promise<TableDescription> {
    // Allow schema-qualified names; default schema otherwise.
    const parts = table.split('.');
    const name = parts[parts.length - 1] as string;
    const schema = parts.length > 1 ? (parts[0] as string) : this.requireDatabase(`describe_table "${table}"`);

    const columnRows = await this.fetchRows(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS notNull,
              COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [schema, name],
    );
    if (columnRows.length === 0) {
      throw new DriverError(`table "${table}" not found in schema "${schema}"`);
    }

    // One row per indexed column; group into per-index column lists.
    const indexRows = await this.fetchRows(
      `SELECT INDEX_NAME AS indexName, NON_UNIQUE = 0 AS isUnique, COLUMN_NAME AS columnName
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, name],
    );
    const byIndex = new Map<string, IndexInfo>();
    for (const row of indexRows) {
      const indexName = String(row.indexName);
      let entry = byIndex.get(indexName);
      if (entry === undefined) {
        entry = {
          name: indexName,
          unique: row.isUnique === 1,
          columns: [],
          origin: indexName === 'PRIMARY' ? 'pk' : undefined,
        };
        byIndex.set(indexName, entry);
      }
      entry.columns.push(String(row.columnName));
    }

    const foreignKeys = (
      await this.fetchRows(
        `SELECT kcu.COLUMN_NAME AS columnName,
                kcu.REFERENCED_TABLE_NAME AS refTable,
                kcu.REFERENCED_COLUMN_NAME AS refColumn,
                rc.UPDATE_RULE AS onUpdate,
                rc.DELETE_RULE AS onDelete
           FROM information_schema.KEY_COLUMN_USAGE kcu
           JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                AND rc.TABLE_NAME = kcu.TABLE_NAME
          WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
            AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [schema, name],
      )
    ).map((row) => ({
      column: String(row.columnName),
      referencesTable: String(row.refTable),
      referencesColumn: row.refColumn == null ? null : String(row.refColumn),
      onUpdate: row.onUpdate === undefined ? undefined : String(row.onUpdate),
      onDelete: row.onDelete === undefined ? undefined : String(row.onDelete),
    }));

    let createSql: string | undefined;
    const createRows = await this.fetchRows(`SHOW CREATE TABLE ${quoteIdent(`${schema}.${name}`)}`);
    const createRow = createRows[0];
    const createText = createRow === undefined ? undefined : (createRow['Create Table'] ?? createRow['Create View']);
    if (typeof createText === 'string') createSql = createText;

    return {
      table,
      columns: columnRows.map((row) => ({
        name: String(row.name),
        type: String(row.type),
        notNull: row.notNull === 1,
        defaultValue: row.defaultValue ?? null,
        primaryKey: row.columnKey === 'PRI',
      })),
      indexes: [...byIndex.values()],
      foreignKeys,
      createSql,
    };
  }

  async sampleRows(table: string, limit: number, options: QueryOptions): Promise<QueryResult> {
    const db = this.requireDatabase(`sample_rows "${table}"`);
    const effective = Math.max(1, Math.min(limit, options.maxRows));
    const qualified = table.includes('.') ? table : `${db}.${table}`;
    return this.query(`SELECT * FROM ${quoteIdent(qualified)} LIMIT ?`, [effective], options);
  }

  async explainQuery(sql: string, params: unknown, options: QueryOptions): Promise<QueryResult> {
    // MySQL EXPLAIN plans without executing, including for DML.
    return this.query(`EXPLAIN ${sql}`, params, options);
  }

  async close(): Promise<void> {
    await this.conn.end();
  }

  // ---- internals -----------------------------------------------------------

  private async fetchRows(
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.query(sql, params, { readonly: false, maxRows: 100_000 });
    return result.kind === 'rows' ? result.rows : [];
  }
}

function databaseFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const db = decodeURIComponent(path.replace(/^\//, ''));
    return db.length > 0 ? db : undefined;
  } catch {
    throw new DriverError(`invalid mysql DSN: ${url}`);
  }
}

export const mysqlDriver: DbDriver = {
  name: 'mysql',
  aliases: ['mariadb'],
  description: 'MySQL / MariaDB via mysql2',
  dsnExamples: [
    'mysql://user:password@127.0.0.1:3306/dbname',
    'mariadb://user@localhost/db',
    'mysql://user@host/db?mode=ro',
  ],
  parseDsn(dsn: string): DriverConfig {
    let url: URL;
    try {
      url = new URL(dsn);
    } catch {
      throw new DriverError(`invalid mysql DSN "${dsn}" (expected mysql://user:pass@host:3306/db)`);
    }
    if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
      throw new DriverError(`mysql DSN must use mysql:// or mariadb://, got "${url.protocol}//"`);
    }
    // mysql2's uri parser speaks mysql://; normalize the alias away.
    return url.protocol === 'mariadb:' ? { url: dsn.replace(/^mariadb:/i, 'mysql:') } : { url: dsn };
  },
  async open(config, options: QueryOptions) {
    const url = config.url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new DriverError('mysql config requires string "url"');
    }
    const database = databaseFromUrl(url);

    let conn: Connection;
    try {
      conn = await createConnection({ uri: url, dateStrings: true } as never);
    } catch (error) {
      throw new DriverError(`cannot connect to mysql: ${errorMessage(error)}`);
    }

    if (options.readonly) {
      try {
        await conn.query('SET SESSION TRANSACTION READ ONLY');
      } catch (error) {
        await conn.end().catch(() => undefined);
        throw new DriverError(`mysql: cannot set read-only session: ${errorMessage(error)}`);
      }
    }

    return new MysqlConnection(conn, database);
  },
};
