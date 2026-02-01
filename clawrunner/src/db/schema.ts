import {
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubId: varchar('github_id', { length: 255 }).notNull().unique(),
    githubUsername: varchar('github_username', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).unique(),
    avatarUrl: varchar('avatar_url', { length: 512 }),
    nangoConnectionId: varchar('nango_connection_id', { length: 255 }),
    plan: varchar('plan', { length: 50 }).notNull().default('free'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    githubIdIdx: index('idx_users_github_id').on(table.githubId),
    githubUsernameIdx: index('idx_users_github_username').on(table.githubUsername),
    emailIdx: index('idx_users_email').on(table.email),
    nangoConnectionIdx: index('idx_users_nango_connection_id').on(table.nangoConnectionId),
  }),
);

export const machines = pgTable(
  'machines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    flyMachineId: varchar('fly_machine_id', { length: 255 }),
    name: varchar('name', { length: 255 }).notNull(),
    region: varchar('region', { length: 64 }),
    status: varchar('status', { length: 50 }).notNull().default('provisioning'),
    provider: varchar('provider', { length: 50 }).notNull().default('fly'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_machines_user_id').on(table.userId),
    flyMachineIdIdx: index('idx_machines_fly_machine_id').on(table.flyMachineId),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  machines: many(machines),
}));

export const machinesRelations = relations(machines, ({ one }) => ({
  user: one(users, {
    fields: [machines.userId],
    references: [users.id],
  }),
}));

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Machine = InferSelectModel<typeof machines>;
export type NewMachine = InferInsertModel<typeof machines>;
