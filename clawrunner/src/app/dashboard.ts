import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import {
  machineQueries,
  type Machine,
  type User,
  userQueries,
} from '../db/index.js';

type RequestWithUser = Request & {
  user?: { id?: string };
  auth?: { userId?: string };
  session?: { userId?: string };
};

export interface UsageStats {
  totalMachines: number;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  byRegion: Record<string, number>;
  newestMachineCreatedAt?: string;
}

export interface DashboardMachine {
  id: string;
  name: string;
  region: string | null;
  status: string;
  provider: string;
  flyMachineId: string | null;
  createdAt: string;
}

export interface DashboardPayload {
  user: Pick<User, 'id' | 'githubUsername' | 'githubId' | 'email' | 'avatarUrl' | 'plan'>;
  machines: DashboardMachine[];
  usage: UsageStats;
}

class DashboardError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'DashboardError';
  }
}

function extractUserId(req: RequestWithUser): string | null {
  // Prefer an authenticated user object if middleware attached one
  if (req.user?.id) return req.user.id;
  if (req.auth?.userId) return req.auth.userId;
  if (req.session?.userId) return req.session.userId;

  // Fallback to header (still scoped to current request, avoids query-based impersonation)
  const header = req.headers['x-user-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]) return header[0];

  return null;
}

function normalizeDate(input: Date | string | null | undefined): string | undefined {
  if (!input) return undefined;
  const asDate = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(asDate.getTime())) return undefined;
  return asDate.toISOString();
}

function buildUsageStats(machines: Machine[]): UsageStats {
  const usage: UsageStats = {
    totalMachines: machines.length,
    byStatus: {},
    byProvider: {},
    byRegion: {},
  };

  for (const machine of machines) {
    usage.byStatus[machine.status] = (usage.byStatus[machine.status] || 0) + 1;
    usage.byProvider[machine.provider] = (usage.byProvider[machine.provider] || 0) + 1;
    if (machine.region) {
      usage.byRegion[machine.region] = (usage.byRegion[machine.region] || 0) + 1;
    }

    const createdAt = normalizeDate(machine.createdAt);
    if (createdAt && (!usage.newestMachineCreatedAt || createdAt > usage.newestMachineCreatedAt)) {
      usage.newestMachineCreatedAt = createdAt;
    }
  }

  return usage;
}

export async function fetchDashboard(userId: string): Promise<DashboardPayload> {
  try {
    const user = await userQueries.findById(userId);
    if (!user) {
      throw new DashboardError(404, 'User not found');
    }

    const machines = await machineQueries.listForUser(userId);
    const usage = buildUsageStats(machines);

    const payload: DashboardPayload = {
      user: {
        id: user.id,
        githubUsername: user.githubUsername,
        githubId: user.githubId,
        email: user.email ?? null,
        avatarUrl: user.avatarUrl ?? null,
        plan: user.plan,
      },
      machines: machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        region: machine.region ?? null,
        status: machine.status,
        provider: machine.provider,
        flyMachineId: machine.flyMachineId ?? null,
        createdAt: normalizeDate(machine.createdAt) ?? '',
      })),
      usage,
    };

    return payload;
  } catch (error) {
    if (error instanceof DashboardError) {
      throw error;
    }
    console.error('[dashboard] Database error while building dashboard', error);
    throw new DashboardError(500, 'Failed to load dashboard data');
  }
}

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req: RequestWithUser, res: Response, _next: NextFunction) => {
  const userId = extractUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = await fetchDashboard(userId);
    res.json(payload);
  } catch (error) {
    if (error instanceof DashboardError) {
      res.status(error.status).json({ error: error.message });
      return;
    }

    console.error('[dashboard] Unexpected error', error);
    res.status(500).json({ error: 'Unexpected error loading dashboard' });
  }
});
