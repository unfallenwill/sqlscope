// SQLScope driver contract.
//
// A driver owns everything database-specific: how its DSN scheme parses into
// a config, how to run a statement, and how to introspect the schema. The
// ConnectionManager and MCP tools stay driver-agnostic; adding PostgreSQL,
// etc. means adding a file under src/drivers/ and registering it.
//
// The user-facing connection format is a standard RFC 3986 URI, one shape
// for every driver (per-database conventions follow their specs —
// SQLAlchemy/DATABASE_URL for sqlite, MySQL Shell/mysql2 for mysql, and
// libpq's postgresql:// when a PG driver lands):
//
//   sqlite:///app.db            relative path (SQLAlchemy/DATABASE_URL form)
//   sqlite:////var/data/app.db  absolute path
//   sqlite:///:memory:          in-memory database
//   mysql://user:pass@host:3306/dbname       mariadb://user@host/db
//
// Universal query params (stripped centrally, before parseDsn):
//   mode=ro                     read-only connection (SQLite URI spec name)
//   (driver-specific params after "?" are passed to the driver)

export type DriverConfig = Record<string, unknown>;

/** Options per connection (server defaults + per-DSN overrides). */
export interface QueryOptions {
  /** Reject anything that can mutate data or schema. */
  readonly: boolean;
  /** Hard cap on returned rows; rows past the cap are dropped and flagged. */
  maxRows: number;
}

export type QueryResult =
  | {
      kind: 'rows';
      columns: string[];
      rows: Array<Record<string, unknown>>;
      rowCount: number;
      truncated: boolean;
    }
  | {
      kind: 'execution';
      changes: number;
      lastInsertRowid?: number;
    }
  | {
      kind: 'exec';
      /** Number of statements executed (multi-statement scripts). */
      statements: number;
    };

export interface TableSummary {
  name: string;
  /** "table" | "view" (drivers may report engine-specific types). */
  type: string;
  columnCount?: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: unknown;
  /** true / ordinal position in the primary key (0 = not part of it). */
  primaryKey: boolean | number;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
  origin?: string;
}

export interface ForeignKeyInfo {
  column: string;
  referencesTable: string;
  referencesColumn: string | null;
  onUpdate?: string;
  onDelete?: string;
}

export interface TableDescription {
  table: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  createSql?: string;
  rowCount?: number;
}

export interface DbConnection {
  /** Driver name (for diagnostics). */
  readonly driver: string;
  query(sql: string, params: unknown, options: QueryOptions): Promise<QueryResult>;
  listTables(): Promise<TableSummary[]>;
  describeTable(table: string): Promise<TableDescription>;
  sampleRows(table: string, limit: number, options: QueryOptions): Promise<QueryResult>;
  explainQuery(sql: string, params: unknown, options: QueryOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

export interface DbDriver {
  /** Unique driver id — this is the DSN scheme ("sqlite:", "mysql://"). */
  readonly name: string;
  /** Alternative DSN schemes routed to this driver (e.g. "mariadb"). */
  readonly aliases?: readonly string[];
  readonly description: string;
  /** Example DSNs for help text and error messages. */
  readonly dsnExamples: readonly string[];
  /**
   * Parse a scheme-matched DSN (universal ?params already stripped) into a
   * driver config. Throw DriverError with a helpful message on bad input.
   */
  parseDsn(dsn: string): DriverConfig;
  open(config: DriverConfig, options: QueryOptions): Promise<DbConnection>;
}

export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverError';
  }
}

/** Extract the DSN scheme ("sqlite", "mysql", ...) or undefined. */
export function schemeOf(dsn: string): string | undefined {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(dsn);
  return match === null ? undefined : match[0].slice(0, -1);
}
