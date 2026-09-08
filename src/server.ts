// SQLScope MCP tool surface.
//
// Tools (clients see them as sqlscope.<tool>):
//   list_tables     — tables + views in the connection's default schema
//   describe_table  — columns, indexes, foreign keys, DDL, row count
//   sample_rows     — first N rows of a table
//   query           — run SQL with optional bound params
//   explain_query   — execution plan without running the statement

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ConnectionManager } from './connections.js';

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return value;
}

function jsonContent(value: unknown, isError = false): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, jsonReplacer, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(error: unknown) {
  return jsonContent({ error: error instanceof Error ? error.message : String(error) }, true);
}

const CONNECTION_ARG = z
  .string()
  .optional()
  .describe(
    'Named connection to use. Omit when only one connection is configured (or it is named "default").',
  );

const PARAMS_ARG = z
  .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .optional()
  .describe(
    'Bound parameters: array for positional placeholders (?), object for named ones (:name) where the driver supports them.',
  );

export function buildServer(manager: ConnectionManager): McpServer {
  const server = new McpServer(
    { name: 'sqlscope', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'List all tables and views in the connection\'s default schema, with column counts. Use this first to discover what to query.',
      inputSchema: z.object({ connection: CONNECTION_ARG }),
    },
    async ({ connection }) => {
      try {
        return jsonContent(await manager.listTables(connection));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Describe one table: columns (name, type, nullability, default, primary key), indexes, foreign keys, the CREATE statement, and the row count.',
      inputSchema: z.object({
        table: z.string().describe('Table name (optionally schema-qualified, e.g. "mydb.users")'),
        connection: CONNECTION_ARG,
      }),
    },
    async ({ table, connection }) => {
      try {
        return jsonContent(await manager.describeTable(table, connection));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'sample_rows',
    {
      title: 'Sample rows',
      description:
        'Fetch the first N rows of a table (default 10) to see real values — useful for understanding data shape before writing queries.',
      inputSchema: z.object({
        table: z.string().describe('Table name (optionally schema-qualified)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Number of rows to return (default 10)'),
        connection: CONNECTION_ARG,
      }),
    },
    async ({ table, limit, connection }) => {
      try {
        return jsonContent(await manager.sampleRows(table, limit ?? 10, connection));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'query',
    {
      title: 'Run SQL',
      description:
        'Run a SQL statement. SELECT/SHOW/EXPLAIN return rows (capped by maxRows, default 1000); INSERT/UPDATE/DELETE return affected-row counts; multi-statement scripts are supported where the driver allows them. Params bind with ? (array) or :name (object) where supported.',
      inputSchema: z.object({
        sql: z.string().describe('SQL statement or script to run'),
        params: PARAMS_ARG,
        connection: CONNECTION_ARG,
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .optional()
          .describe('Row cap for this query only (server default: 1000)'),
      }),
    },
    async ({ sql, params, connection, maxRows }) => {
      try {
        return jsonContent(await manager.query(sql, params, connection, maxRows));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain query plan',
      description:
        'Show the execution plan for a statement (EXPLAIN / EXPLAIN QUERY PLAN) without running it — index usage, scan order, estimated rows. Safe on write statements.',
      inputSchema: z.object({
        sql: z.string().describe('Statement to plan (does not get executed)'),
        params: PARAMS_ARG,
        connection: CONNECTION_ARG,
      }),
    },
    async ({ sql, params, connection }) => {
      try {
        return jsonContent(await manager.explainQuery(sql, params, connection));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
