import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const opsRequests = sqliteTable(
  "ops_requests",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    risk: text("risk").notNull(),
    result: text("result"),
    workerLog: text("worker_log"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    claimedAt: integer("claimed_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("idx_ops_requests_status_updated").on(table.status, table.updatedAt),
  ],
);
