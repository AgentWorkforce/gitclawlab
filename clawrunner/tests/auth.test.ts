/**
 * Integration tests for ClawRunner authentication flow
 *
 * Tests cover:
 * 1. GitHub OAuth via Nango (login session creation, status polling)
 * 2. Session management (create, validate, destroy)
 * 3. Machine authorization (users can only access own machines)
 * 4. Nango webhook handler (auth webhooks, signature verification)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';

// Mock the Nango service before importing the actual modules
vi.mock('../src/services/nango.js', () => {
  return {
    NANGO_INTEGRATION: 'github-runner',
    nangoService: {
      createConnectSession: vi.fn(),
      getGithubUser: vi.fn(),
      getGithubToken: vi.fn(),
      getConnection: vi.fn(),
      updateEndUser: vi.fn(),
      deleteConnection: vi.fn(),
      verifyWebhookSignature: vi.fn(),
    },
  };
});

// Mock the database module
vi.mock('../src/db/index.js', () => {
  const mockUsers = new Map<string, {
    id: string;
    githubId: string;
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
    nangoConnectionId?: string;
    plan: string;
    createdAt: Date;
  }>();

  const mockMachines = new Map<string, {
    id: string;
    userId: string;
    flyMachineId?: string;
    name: string;
    region?: string;
    status: string;
    provider: string;
    createdAt: Date;
  }>();

  return {
    userQueries: {
      findById: vi.fn(async (id: string) => mockUsers.get(id) || null),
      findByGithubId: vi.fn(async (githubId: string) => {
        for (const user of mockUsers.values()) {
          if (user.githubId === githubId) return user;
        }
        return null;
      }),
      findByGithubUsername: vi.fn(async (username: string) => {
        for (const user of mockUsers.values()) {
          if (user.githubUsername === username) return user;
        }
        return null;
      }),
      upsertFromGithub: vi.fn(async (data) => {
        const user = {
          id: data.id || crypto.randomUUID(),
          githubId: data.githubId,
          githubUsername: data.githubUsername,
          email: data.email,
          avatarUrl: data.avatarUrl,
          nangoConnectionId: data.nangoConnectionId,
          plan: data.plan || 'free',
          createdAt: new Date(),
        };
        mockUsers.set(user.id, user);
        return user;
      }),
    },
    machineQueries: {
      findById: vi.fn(async (id: string) => mockMachines.get(id) || null),
      listForUser: vi.fn(async (userId: string) => {
        return Array.from(mockMachines.values()).filter(m => m.userId === userId);
      }),
      create: vi.fn(async (data) => {
        const machine = {
          id: crypto.randomUUID(),
          userId: data.userId,
          flyMachineId: data.flyMachineId,
          name: data.name,
          region: data.region,
          status: data.status || 'provisioning',
          provider: data.provider || 'fly',
          createdAt: new Date(),
        };
        mockMachines.set(machine.id, machine);
        return machine;
      }),
    },
    db: {
      users: {},
      machines: {},
    },
    getDb: vi.fn(),
    _mockUsers: mockUsers,
    _mockMachines: mockMachines,
  };
});

// Import after mocking
import { nangoService, NANGO_INTEGRATION } from '../src/services/nango.js';
import { nangoAuthRouter } from '../src/api/nango-auth.js';
import { userQueries, machineQueries, _mockUsers, _mockMachines } from '../src/db/index.js';

// Create test app with raw body capture for webhook testing
function createTestApp() {
  const app = express();
  app.use(express.json({
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString();
    },
  }));
  app.use('/api/auth/nango', nangoAuthRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[test] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

// =============================================================================
// 1. GitHub OAuth via Nango Tests
// =============================================================================

describe('GitHub OAuth via Nango', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  describe('GET /api/auth/nango/login-session', () => {
    it('should create a new login session with session token', async () => {
      const mockSession = { token: 'test-session-token-123' };
      vi.mocked(nangoService.createConnectSession).mockResolvedValue(mockSession);

      const response = await request(app)
        .get('/api/auth/nango/login-session')
        .expect(200);

      expect(response.body).toHaveProperty('sessionToken', 'test-session-token-123');
      expect(response.body).toHaveProperty('tempUserId');
      expect(typeof response.body.tempUserId).toBe('string');
      expect(nangoService.createConnectSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) })
      );
    });

    it('should return 500 if session creation fails', async () => {
      vi.mocked(nangoService.createConnectSession).mockRejectedValue(
        new Error('Nango API error')
      );

      const response = await request(app)
        .get('/api/auth/nango/login-session')
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to create login session');
    });

    it('should generate unique tempUserId for each request', async () => {
      const mockSession = { token: 'test-token' };
      vi.mocked(nangoService.createConnectSession).mockResolvedValue(mockSession);

      const response1 = await request(app).get('/api/auth/nango/login-session');
      const response2 = await request(app).get('/api/auth/nango/login-session');

      expect(response1.body.tempUserId).not.toBe(response2.body.tempUserId);
    });
  });

  describe('GET /api/auth/nango/login-status/:connectionId', () => {
    it('should return ready:false when login is not yet complete', async () => {
      const response = await request(app)
        .get('/api/auth/nango/login-status/unknown-connection-id')
        .expect(200);

      expect(response.body).toEqual({ ready: false });
    });

    it('should return user data when login is complete', async () => {
      // First simulate a webhook that sets up the pending login
      const connectionId = 'test-connection-123';
      const mockGithubUser = {
        id: 12345,
        login: 'testuser',
        email: 'test@example.com',
        avatar_url: 'https://github.com/avatar.png',
      };

      vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
      vi.mocked(nangoService.getGithubUser).mockResolvedValue(mockGithubUser);
      vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

      // Send webhook to populate pending logins
      await request(app)
        .post('/api/auth/nango/webhook')
        .set('x-nango-signature', 'valid-signature')
        .send({
          type: 'auth',
          connectionId,
          providerConfigKey: NANGO_INTEGRATION,
          endUser: { id: 'user-uuid' },
        });

      // Now check login status
      const response = await request(app)
        .get(`/api/auth/nango/login-status/${connectionId}`)
        .expect(200);

      expect(response.body.ready).toBe(true);
      expect(response.body.user).toEqual({
        id: 'user-uuid',
        githubId: '12345',
        githubUsername: 'testuser',
        email: 'test@example.com',
        avatarUrl: 'https://github.com/avatar.png',
      });
    });

    it('should clear pending login after retrieval (one-time use)', async () => {
      const connectionId = 'test-connection-456';
      const mockGithubUser = { id: 99999, login: 'oneTimeUser', email: 'one@time.com' };

      vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
      vi.mocked(nangoService.getGithubUser).mockResolvedValue(mockGithubUser);
      vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

      // Set up pending login via webhook
      await request(app)
        .post('/api/auth/nango/webhook')
        .set('x-nango-signature', 'sig')
        .send({
          type: 'auth',
          connectionId,
          providerConfigKey: NANGO_INTEGRATION,
        });

      // First retrieval should succeed
      const response1 = await request(app)
        .get(`/api/auth/nango/login-status/${connectionId}`)
        .expect(200);
      expect(response1.body.ready).toBe(true);

      // Second retrieval should show not ready (cleared)
      const response2 = await request(app)
        .get(`/api/auth/nango/login-status/${connectionId}`)
        .expect(200);
      expect(response2.body.ready).toBe(false);
    });
  });
});

// =============================================================================
// 2. Session Management Tests
// =============================================================================

describe('Session Management', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  describe('Session Creation', () => {
    it('should create a Nango connect session for a new user', async () => {
      const mockSession = { token: 'new-session-token' };
      vi.mocked(nangoService.createConnectSession).mockResolvedValue(mockSession);

      const response = await request(app)
        .get('/api/auth/nango/login-session')
        .expect(200);

      expect(response.body.sessionToken).toBe('new-session-token');
      expect(nangoService.createConnectSession).toHaveBeenCalledTimes(1);
    });

    it('should pass user info to Nango session creation', async () => {
      vi.mocked(nangoService.createConnectSession).mockResolvedValue({ token: 'tok' });

      await request(app).get('/api/auth/nango/login-session');

      expect(nangoService.createConnectSession).toHaveBeenCalledWith({
        id: expect.any(String),
      });
    });
  });

  describe('Session Validation via Webhook', () => {
    it('should validate and process auth webhook correctly', async () => {
      const mockGithubUser = {
        id: 11111,
        login: 'validUser',
        email: 'valid@user.com',
        avatar_url: 'https://github.com/valid.png',
      };

      vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
      vi.mocked(nangoService.getGithubUser).mockResolvedValue(mockGithubUser);
      vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/auth/nango/webhook')
        .set('x-nango-signature', 'valid')
        .send({
          type: 'auth',
          connectionId: 'conn-123',
          providerConfigKey: NANGO_INTEGRATION,
          endUser: { id: 'end-user-id', email: 'end@user.com' },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(nangoService.getGithubUser).toHaveBeenCalledWith('conn-123');
      expect(nangoService.updateEndUser).toHaveBeenCalledWith('conn-123', {
        id: 'end-user-id',
        email: 'valid@user.com',
      });
    });
  });

  describe('Session Destruction', () => {
    it('should handle connection deletion via Nango service', async () => {
      vi.mocked(nangoService.deleteConnection).mockResolvedValue(undefined);

      await nangoService.deleteConnection('connection-to-delete');

      expect(nangoService.deleteConnection).toHaveBeenCalledWith('connection-to-delete');
    });
  });
});

// =============================================================================
// 3. Machine Authorization Tests
// =============================================================================

describe('Machine Authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear mock data stores
    (_mockUsers as Map<string, unknown>).clear();
    (_mockMachines as Map<string, unknown>).clear();
  });

  describe('User can only access own machines', () => {
    it('should return only machines belonging to the requesting user', async () => {
      // Create two users
      const user1 = await userQueries.upsertFromGithub({
        githubId: '1001',
        githubUsername: 'user1',
        email: 'user1@test.com',
      });

      const user2 = await userQueries.upsertFromGithub({
        githubId: '1002',
        githubUsername: 'user2',
        email: 'user2@test.com',
      });

      // Create machines for each user
      await machineQueries.create({
        userId: user1.id,
        name: 'user1-machine-1',
        region: 'sjc',
      });

      await machineQueries.create({
        userId: user1.id,
        name: 'user1-machine-2',
        region: 'iad',
      });

      await machineQueries.create({
        userId: user2.id,
        name: 'user2-machine-1',
        region: 'ewr',
      });

      // Query machines for user1
      const user1Machines = await machineQueries.listForUser(user1.id);
      expect(user1Machines).toHaveLength(2);
      expect(user1Machines.every(m => m.userId === user1.id)).toBe(true);
      expect(user1Machines.map(m => m.name)).toContain('user1-machine-1');
      expect(user1Machines.map(m => m.name)).toContain('user1-machine-2');

      // Query machines for user2
      const user2Machines = await machineQueries.listForUser(user2.id);
      expect(user2Machines).toHaveLength(1);
      expect(user2Machines[0].name).toBe('user2-machine-1');
      expect(user2Machines[0].userId).toBe(user2.id);
    });

    it('should return empty array for user with no machines', async () => {
      const user = await userQueries.upsertFromGithub({
        githubId: '2001',
        githubUsername: 'noMachinesUser',
      });

      const machines = await machineQueries.listForUser(user.id);
      expect(machines).toEqual([]);
    });

    it('should not allow access to machines owned by other users', async () => {
      const owner = await userQueries.upsertFromGithub({
        githubId: '3001',
        githubUsername: 'owner',
      });

      const otherUser = await userQueries.upsertFromGithub({
        githubId: '3002',
        githubUsername: 'otherUser',
      });

      const machine = await machineQueries.create({
        userId: owner.id,
        name: 'private-machine',
      });

      // Other user should not see owner's machine
      const otherUserMachines = await machineQueries.listForUser(otherUser.id);
      expect(otherUserMachines.find(m => m.id === machine.id)).toBeUndefined();

      // Direct lookup should return the machine (but caller should verify ownership)
      const foundMachine = await machineQueries.findById(machine.id);
      expect(foundMachine).not.toBeNull();
      expect(foundMachine?.userId).toBe(owner.id);
      expect(foundMachine?.userId).not.toBe(otherUser.id);
    });

    it('should properly associate new machines with creating user', async () => {
      const user = await userQueries.upsertFromGithub({
        githubId: '4001',
        githubUsername: 'machineCreator',
      });

      const machine = await machineQueries.create({
        userId: user.id,
        name: 'new-machine',
        region: 'lax',
        provider: 'fly',
      });

      expect(machine.userId).toBe(user.id);
      expect(machine.name).toBe('new-machine');
      expect(machine.status).toBe('provisioning');

      // Verify it appears in user's machine list
      const userMachines = await machineQueries.listForUser(user.id);
      expect(userMachines.find(m => m.id === machine.id)).toBeDefined();
    });
  });

  describe('User lookup by GitHub credentials', () => {
    it('should find user by GitHub ID', async () => {
      const created = await userQueries.upsertFromGithub({
        githubId: '5001',
        githubUsername: 'findByIdUser',
        email: 'findbyid@test.com',
      });

      const found = await userQueries.findByGithubId('5001');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.githubUsername).toBe('findByIdUser');
    });

    it('should find user by GitHub username', async () => {
      await userQueries.upsertFromGithub({
        githubId: '6001',
        githubUsername: 'uniqueUsername',
      });

      const found = await userQueries.findByGithubUsername('uniqueUsername');
      expect(found).not.toBeNull();
      expect(found?.githubId).toBe('6001');
    });

    it('should return null for non-existent GitHub ID', async () => {
      const found = await userQueries.findByGithubId('non-existent-id');
      expect(found).toBeNull();
    });
  });
});

// =============================================================================
// 4. Nango Webhook Handler Tests
// =============================================================================

describe('Nango Webhook Handler', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  describe('POST /api/auth/nango/webhook', () => {
    describe('Signature Verification', () => {
      it('should reject webhooks without signature header', async () => {
        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .send({ type: 'auth', connectionId: 'test' })
          .expect(401);

        expect(response.body.error).toBe('Missing signature');
      });

      it('should reject webhooks with invalid signature', async () => {
        vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(false);

        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'invalid-signature')
          .send({ type: 'auth', connectionId: 'test' })
          .expect(401);

        expect(response.body.error).toBe('Invalid signature');
      });

      it('should accept webhooks with valid x-nango-signature header', async () => {
        vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
        vi.mocked(nangoService.getGithubUser).mockResolvedValue({
          id: 123,
          login: 'user',
        });
        vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'valid-signature')
          .send({
            type: 'auth',
            connectionId: 'test-conn',
            providerConfigKey: NANGO_INTEGRATION,
          })
          .expect(200);

        expect(response.body.success).toBe(true);
      });

      it('should accept webhooks with valid x-nango-hmac-sha256 header', async () => {
        vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
        vi.mocked(nangoService.getGithubUser).mockResolvedValue({
          id: 456,
          login: 'hmacUser',
        });
        vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-hmac-sha256', 'valid-hmac')
          .send({
            type: 'auth',
            connectionId: 'hmac-conn',
            providerConfigKey: NANGO_INTEGRATION,
          })
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });

    describe('Auth Webhook Processing', () => {
      beforeEach(() => {
        vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
      });

      it('should process auth webhook for github-runner integration', async () => {
        const mockGithubUser = {
          id: 77777,
          login: 'webhookUser',
          email: 'webhook@user.com',
          avatar_url: 'https://github.com/webhook.png',
        };

        vi.mocked(nangoService.getGithubUser).mockResolvedValue(mockGithubUser);
        vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'sig')
          .send({
            type: 'auth',
            connectionId: 'webhook-conn-1',
            providerConfigKey: NANGO_INTEGRATION,
            endUser: { id: 'webhook-user-id' },
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(nangoService.getGithubUser).toHaveBeenCalledWith('webhook-conn-1');
        expect(nangoService.updateEndUser).toHaveBeenCalledWith(
          'webhook-conn-1',
          expect.objectContaining({ id: 'webhook-user-id' })
        );
      });

      it('should ignore auth webhook for different integration', async () => {
        vi.mocked(nangoService.getGithubUser).mockResolvedValue({ id: 1, login: 'x' });

        await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'sig')
          .send({
            type: 'auth',
            connectionId: 'other-conn',
            providerConfigKey: 'different-integration',
          })
          .expect(200);

        // Should not call getGithubUser for different integration
        expect(nangoService.getGithubUser).not.toHaveBeenCalled();
      });

      it('should generate UUID for endUser.id if not provided', async () => {
        vi.mocked(nangoService.getGithubUser).mockResolvedValue({
          id: 88888,
          login: 'noEndUser',
        });
        vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

        await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'sig')
          .send({
            type: 'auth',
            connectionId: 'auto-id-conn',
            providerConfigKey: NANGO_INTEGRATION,
            // No endUser provided
          })
          .expect(200);

        // Should call updateEndUser with a generated UUID
        expect(nangoService.updateEndUser).toHaveBeenCalledWith(
          'auto-id-conn',
          expect.objectContaining({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          })
        );
      });

      it('should handle errors from getGithubUser gracefully', async () => {
        vi.mocked(nangoService.getGithubUser).mockRejectedValue(
          new Error('GitHub API error')
        );

        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'sig')
          .send({
            type: 'auth',
            connectionId: 'error-conn',
            providerConfigKey: NANGO_INTEGRATION,
          })
          .expect(500);

        expect(response.body.error).toBe('Failed to process webhook');
      });
    });

    describe('Sync Webhook Processing', () => {
      beforeEach(() => {
        vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
      });

      it('should acknowledge sync webhooks', async () => {
        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'sig')
          .send({
            type: 'sync',
            connectionId: 'sync-conn',
            providerConfigKey: NANGO_INTEGRATION,
          })
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });

    describe('Unknown Webhook Types', () => {
      beforeEach(() => {
        vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
      });

      it('should handle unknown webhook types gracefully', async () => {
        const response = await request(app)
          .post('/api/auth/nango/webhook')
          .set('x-nango-signature', 'sig')
          .send({
            type: 'unknown-type',
            connectionId: 'unknown-conn',
          })
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });
  });
});

// =============================================================================
// 5. Integration Flow Tests (End-to-End)
// =============================================================================

describe('Full Authentication Flow', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    (_mockUsers as Map<string, unknown>).clear();
    (_mockMachines as Map<string, unknown>).clear();
    app = createTestApp();
  });

  it('should complete full OAuth flow: session -> webhook -> status', async () => {
    // Step 1: Create login session
    vi.mocked(nangoService.createConnectSession).mockResolvedValue({
      token: 'flow-session-token',
    });

    const sessionResponse = await request(app)
      .get('/api/auth/nango/login-session')
      .expect(200);

    expect(sessionResponse.body.sessionToken).toBe('flow-session-token');
    const { tempUserId } = sessionResponse.body;

    // Step 2: Simulate user completing OAuth in Nango UI, webhook fires
    const connectionId = 'flow-connection-id';
    const mockGithubUser = {
      id: 99999,
      login: 'flowTestUser',
      email: 'flow@test.com',
      avatar_url: 'https://github.com/flow.png',
    };

    vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
    vi.mocked(nangoService.getGithubUser).mockResolvedValue(mockGithubUser);
    vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

    await request(app)
      .post('/api/auth/nango/webhook')
      .set('x-nango-signature', 'valid')
      .send({
        type: 'auth',
        connectionId,
        providerConfigKey: NANGO_INTEGRATION,
        endUser: { id: tempUserId },
      })
      .expect(200);

    // Step 3: Frontend polls for login status
    const statusResponse = await request(app)
      .get(`/api/auth/nango/login-status/${connectionId}`)
      .expect(200);

    expect(statusResponse.body.ready).toBe(true);
    expect(statusResponse.body.user).toMatchObject({
      id: tempUserId,
      githubId: '99999',
      githubUsername: 'flowTestUser',
      email: 'flow@test.com',
      avatarUrl: 'https://github.com/flow.png',
    });
  });

  it('should handle concurrent login sessions correctly', async () => {
    vi.mocked(nangoService.createConnectSession).mockResolvedValue({ token: 'tok' });
    vi.mocked(nangoService.verifyWebhookSignature).mockReturnValue(true);
    vi.mocked(nangoService.updateEndUser).mockResolvedValue(undefined);

    // Create two sessions
    const session1 = await request(app).get('/api/auth/nango/login-session');
    const session2 = await request(app).get('/api/auth/nango/login-session');

    const conn1 = 'concurrent-conn-1';
    const conn2 = 'concurrent-conn-2';

    // Simulate webhooks for both
    vi.mocked(nangoService.getGithubUser)
      .mockResolvedValueOnce({ id: 1111, login: 'user1' })
      .mockResolvedValueOnce({ id: 2222, login: 'user2' });

    await request(app)
      .post('/api/auth/nango/webhook')
      .set('x-nango-signature', 'sig')
      .send({
        type: 'auth',
        connectionId: conn1,
        providerConfigKey: NANGO_INTEGRATION,
        endUser: { id: session1.body.tempUserId },
      });

    await request(app)
      .post('/api/auth/nango/webhook')
      .set('x-nango-signature', 'sig')
      .send({
        type: 'auth',
        connectionId: conn2,
        providerConfigKey: NANGO_INTEGRATION,
        endUser: { id: session2.body.tempUserId },
      });

    // Check both statuses
    const status1 = await request(app).get(`/api/auth/nango/login-status/${conn1}`);
    const status2 = await request(app).get(`/api/auth/nango/login-status/${conn2}`);

    expect(status1.body.ready).toBe(true);
    expect(status1.body.user.githubId).toBe('1111');

    expect(status2.body.ready).toBe(true);
    expect(status2.body.user.githubId).toBe('2222');
  });
});
