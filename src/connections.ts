// ConnectionManager: named database connections declared as standard DSNs.
//
// Connections are declared in server configuration (CLI flags / env) and
// opened at startup — they are process state, so HTTP-mode requests from
// different clients share the same connections and stdio sessions keep
// them across tool calls.

import {
  DriverError,
  schemeOf,
  type DbConnection,
  type DbDriver,
  type QueryOptions,
  type QueryResult,
  type TableDescription,
  type TableSummary,
} from './driver.js';

export const CONNECTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface ConnectionInfo {
  name: string;
  driver: string;
  createdAt: string;
}

interface Entry {
  info: ConnectionInfo;
  connection: DbConnection;
  options: QueryOptions;
}

/**
 * Split off the universal `mode=ro` param (the SQLite URI spec's name for
 * read-only). Everything else after `?` stays in the DSN for the driver.
 */
function splitUniversalParams(dsn: string): { dsn: string; readonly: boolean } {
  const q = dsn.indexOf('?');
  if (q === -1) return { dsn, readonly: false };
  const base = dsn.slice(0, q);
  const params = new URLSearchParams(dsn.slice(q + 1));
  const readonly = params.get('mode') === 'ro';
  params.delete('mode'); // consumed centrally; drivers never see it
  const rest = params.toString();
  return { dsn: rest.length > 0 ? `${base}?${rest}` : base, readonly };
}

export class ConnectionManager {
  private readonly drivers = new Map<string, DbDriver>();
  private readonly entries = new Map<string, Entry>();
  private readonly defaults: QueryOptions;

  constructor(defaults: QueryOptions) {
    this.defaults = defaults;
  }

  registerDriver(driver: DbDriver): void {
    this.drivers.set(driver.name, driver);
  }

  listDrivers(): DbDriver[] {
    return [...this.drivers.values()];
  }

  list(): ConnectionInfo[] {
    return [...this.entries.values()].map((entry) => entry.info);
  }

  /** Open a named connection from a standard DSN (called during startup). */
  async connect(name: string, dsn: string): Promise<ConnectionInfo> {
    if (!CONNECTION_NAME_RE.test(name)) {
      throw new DriverError(`invalid connection name "${name}": must match ${CONNECTION_NAME_RE.source}`);
    }
    if (this.entries.has(name)) {
      throw new DriverError(`connection "${name}" already exists`);
    }

    const { dsn: clean, readonly } = splitUniversalParams(dsn);
    const scheme = schemeOf(clean);
    if (scheme === undefined) {
      throw new DriverError(
        `dsn must be a URI with a scheme, e.g. "sqlite:///app.db" or "mysql://user@host/db": "${dsn}"`,
      );
    }
    const driver = this.driverFor(scheme);
    if (driver === undefined) {
      throw new DriverError(
        `no driver for scheme "${scheme}"; available: ${[...this.drivers.keys()].join(', ')}`,
      );
    }

    const options: QueryOptions = { ...this.defaults, readonly: this.defaults.readonly || readonly };
    const connection = await driver.open(driver.parseDsn(clean), options);
    const info: ConnectionInfo = { name, driver: driver.name, createdAt: new Date().toISOString() };
    this.entries.set(name, { info, connection, options });
    return info;
  }

  async disconnectAll(): Promise<void> {
    const closers = [...this.entries.values()].map((entry) =>
      Promise.resolve(entry.connection.close()).catch(() => undefined),
    );
    this.entries.clear();
    await Promise.allSettled(closers);
  }

  // ---- tool-facing API -----------------------------------------------------

  async listTables(connection?: string): Promise<{ connection: string; tables: TableSummary[] }> {
    const [name, entry] = this.resolve(connection);
    return { connection: name, tables: await entry.connection.listTables() };
  }

  async describeTable(
    table: string,
    connection?: string,
  ): Promise<{ connection: string } & TableDescription> {
    const [name, entry] = this.resolve(connection);
    return { connection: name, ...(await entry.connection.describeTable(table)) };
  }

  async sampleRows(
    table: string,
    limit: number,
    connection?: string,
  ): Promise<{ connection: string } & QueryResult> {
    const [name, entry] = this.resolve(connection);
    return {
      connection: name,
      ...(await entry.connection.sampleRows(table, limit, entry.options)),
    };
  }

  async query(
    sql: string,
    params: unknown,
    connection?: string,
    maxRows?: number,
  ): Promise<{ connection: string } & QueryResult> {
    const [name, entry] = this.resolve(connection);
    const max = maxRows ?? entry.options.maxRows;
    if (!Number.isInteger(max) || max < 1 || max > 100_000) {
      throw new DriverError('maxRows must be an integer between 1 and 100000');
    }
    return {
      connection: name,
      ...(await entry.connection.query(sql, params, { ...entry.options, maxRows: max })),
    };
  }

  async explainQuery(
    sql: string,
    params: unknown,
    connection?: string,
  ): Promise<{ connection: string } & QueryResult> {
    const [name, entry] = this.resolve(connection);
    return {
      connection: name,
      ...(await entry.connection.explainQuery(sql, params, entry.options)),
    };
  }

  // ---- internals -----------------------------------------------------------

  /** Resolve a scheme to its driver, honoring driver aliases (mariadb → mysql). */
  private driverFor(scheme: string): DbDriver | undefined {
    const direct = this.drivers.get(scheme);
    if (direct !== undefined) return direct;
    return [...this.drivers.values()].find((driver) => driver.aliases?.includes(scheme));
  }

  /** Resolve an optional connection argument to a live entry. */
  private resolve(name?: string): [string, Entry] {
    const available = [...this.entries.keys()];
    if (name !== undefined && name !== '') {
      const entry = this.entries.get(name);
      if (!entry) {
        throw new DriverError(
          available.length > 0
            ? `connection "${name}" does not exist; configured: ${available.join(', ')}`
            : 'no connections are configured',
        );
      }
      return [name, entry];
    }
    if (this.entries.size === 1) {
      const only = [...this.entries.entries()][0] as [string, Entry];
      return only;
    }
    const fallback = this.entries.get('default');
    if (fallback) return ['default', fallback];
    throw new DriverError(
      available.length === 0
        ? 'no connections are configured'
        : `multiple connections configured (${available.join(', ')}); pass "connection"`,
    );
  }
}
