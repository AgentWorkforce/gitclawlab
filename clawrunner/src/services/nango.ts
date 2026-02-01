/**
 * Nango Service for ClawRunner
 *
 * Handles GitHub authentication via Nango for the runner.
 */

import { Nango } from '@nangohq/node';
import type { AxiosResponse } from 'axios';
import crypto from 'node:crypto';

export const NANGO_INTEGRATION = 'github-runner';

export interface GithubUserProfile {
  id: number;
  login: string;
  email?: string;
  avatar_url?: string;
}

class NangoService {
  private _client: Nango | null = null;
  private _secret: string | null = null;

  /** Lazily initialize client on first use */
  private get client(): Nango {
    if (!this._client) {
      const secretKey = process.env.NANGO_SECRET_KEY;
      if (!secretKey) {
        throw new Error('NANGO_SECRET_KEY environment variable is required');
      }
      this._secret = secretKey;
      this._client = new Nango({
        secretKey,
        ...(process.env.NANGO_HOST ? { host: process.env.NANGO_HOST } : {}),
      });
    }
    return this._client;
  }

  private get secret(): string {
    if (!this._secret) {
      const secretKey = process.env.NANGO_SECRET_KEY;
      if (!secretKey) {
        throw new Error('NANGO_SECRET_KEY environment variable is required');
      }
      this._secret = secretKey;
    }
    return this._secret;
  }

  /**
   * Create a Nango connect session for GitHub login.
   */
  async createConnectSession(endUser: { id: string; email?: string }) {
    const { data } = await this.client.createConnectSession({
      allowed_integrations: [NANGO_INTEGRATION],
      end_user: {
        id: endUser.id,
        email: endUser.email,
      },
    });
    return data;
  }

  /**
   * Fetch GitHub user profile via Nango proxy.
   */
  async getGithubUser(connectionId: string): Promise<GithubUserProfile> {
    const response = await this.client.get<GithubUserProfile>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATION,
      endpoint: '/user',
    }) as AxiosResponse<GithubUserProfile>;
    return response.data;
  }

  /**
   * Get GitHub OAuth token for the connection.
   */
  async getGithubToken(connectionId: string): Promise<string> {
    const token = await this.client.getToken(NANGO_INTEGRATION, connectionId);

    if (typeof token === 'string') {
      return token;
    }

    if (token && typeof token === 'object') {
      const tokenObj = token as { access_token?: string; token?: string };
      if (tokenObj.access_token) {
        return tokenObj.access_token;
      }
      if (tokenObj.token) {
        return tokenObj.token;
      }
    }

    throw new Error('Could not retrieve GitHub token');
  }

  /**
   * Get connection metadata.
   */
  async getConnection(connectionId: string): Promise<{
    id: number;
    connection_id: string;
    provider_config_key: string;
    end_user?: { id?: string; email?: string };
    metadata?: Record<string, unknown>;
  }> {
    const connection = await this.client.getConnection(NANGO_INTEGRATION, connectionId);
    return connection as unknown as {
      id: number;
      connection_id: string;
      provider_config_key: string;
      end_user?: { id?: string; email?: string };
      metadata?: Record<string, unknown>;
    };
  }

  /**
   * Update connection end user metadata.
   */
  async updateEndUser(connectionId: string, endUser: { id: string; email?: string }) {
    await this.client.patchConnection(
      { connectionId, provider_config_key: NANGO_INTEGRATION },
      { end_user: endUser }
    );
  }

  /**
   * Delete a connection from Nango.
   */
  async deleteConnection(connectionId: string): Promise<void> {
    await this.client.deleteConnection(NANGO_INTEGRATION, connectionId);
  }

  /**
   * Verify webhook signature sent by Nango.
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    try {
      return this.client.verifyIncomingWebhookRequest(rawBody, headers as Record<string, unknown>);
    } catch (err) {
      console.error('[nango] verifyIncomingWebhookRequest error:', err);
      // Fall back to manual HMAC verification
      const signature = headers['x-nango-signature'] as string | undefined;
      const hmacSha256 = headers['x-nango-hmac-sha256'] as string | undefined;
      if (!signature && !hmacSha256) return false;

      const expectedSignature = crypto
        .createHmac('sha256', this.secret)
        .update(rawBody)
        .digest('hex');
      return signature === expectedSignature || hmacSha256 === expectedSignature;
    }
  }
}

export const nangoService = new NangoService();
