import { eq } from 'drizzle-orm';
import { getDb } from './drizzle.js';
import {
  machines,
  type Machine,
  type NewMachine,
  users,
  type NewUser,
  type User,
} from './schema.js';

export type { Machine, NewMachine, User, NewUser } from './schema.js';
export { users as usersTable, machines as machinesTable } from './schema.js';
export { getDb, getPool, closeDb, schema } from './drizzle.js';

type UpsertUserInput = Omit<NewUser, 'plan'> & { plan?: string };

export const userQueries = {
  async findById(id: string): Promise<User | null> {
    const db = getDb();
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0] ?? null;
  },

  async findByGithubId(githubId: string): Promise<User | null> {
    const db = getDb();
    const result = await db.select().from(users).where(eq(users.githubId, githubId)).limit(1);
    return result[0] ?? null;
  },

  async findByGithubUsername(githubUsername: string): Promise<User | null> {
    const db = getDb();
    const result = await db.select().from(users).where(eq(users.githubUsername, githubUsername)).limit(1);
    return result[0] ?? null;
  },

  async upsertFromGithub(data: UpsertUserInput): Promise<User> {
    const db = getDb();
    const normalizedEmail = data.email?.toLowerCase();

    const result = await db
      .insert(users)
      .values({
        ...data,
        email: normalizedEmail,
        plan: data.plan ?? 'free',
      })
      .onConflictDoUpdate({
        target: users.githubId,
        set: {
          githubUsername: data.githubUsername,
          email: normalizedEmail,
          avatarUrl: data.avatarUrl,
          nangoConnectionId: data.nangoConnectionId,
          plan: data.plan ?? 'free',
        },
      })
      .returning();

    return result[0];
  },

  async setPlan(userId: string, plan: string): Promise<void> {
    const db = getDb();
    await db.update(users).set({ plan }).where(eq(users.id, userId));
  },
};

export const machineQueries = {
  async findById(id: string): Promise<Machine | null> {
    const db = getDb();
    const result = await db.select().from(machines).where(eq(machines.id, id)).limit(1);
    return result[0] ?? null;
  },

  async findByFlyMachineId(flyMachineId: string): Promise<Machine | null> {
    const db = getDb();
    const result = await db.select().from(machines).where(eq(machines.flyMachineId, flyMachineId)).limit(1);
    return result[0] ?? null;
  },

  async listForUser(userId: string): Promise<Machine[]> {
    const db = getDb();
    return db.select().from(machines).where(eq(machines.userId, userId));
  },

  async create(data: NewMachine): Promise<Machine> {
    const db = getDb();
    const result = await db.insert(machines).values(data).returning();
    return result[0];
  },

  async updateStatus(id: string, status: string): Promise<void> {
    const db = getDb();
    await db.update(machines).set({ status }).where(eq(machines.id, id));
  },

  async setFlyMachineId(id: string, flyMachineId: string): Promise<void> {
    const db = getDb();
    await db.update(machines).set({ flyMachineId }).where(eq(machines.id, id));
  },
};

export const db = {
  users: userQueries,
  machines: machineQueries,
  getDb,
};
