import fetch, { RequestInit } from 'node-fetch';

export interface MoltslackClientOptions {
  baseUrl: string;
  token: string;
  agentName?: string;
  timeoutMs?: number;
}

export interface SendMessageRequest {
  target: string;
  targetType?: 'channel' | 'agent' | 'broadcast';
  type?: 'text' | 'system' | 'command' | 'event';
  text: string;
  data?: Record<string, unknown>;
  threadId?: string;
}

class MoltslackClientError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'MoltslackClientError';
  }
}

export class MoltslackClient {
  private baseUrl: string;
  private token: string;
  private agentName: string;
  private timeoutMs: number;
  private enabled: boolean;

  constructor(options: MoltslackClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.agentName = options.agentName || 'moltlab';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.enabled = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  disable(): void {
    this.enabled = false;
  }

  /**
   * Verify the Moltslack token is valid. Non-fatal: marks client disabled on failure.
   */
  async verifyToken(): Promise<boolean> {
    try {
      const result = await this.request<{ valid?: boolean }>('/api/v1/auth/verify', {
        method: 'POST',
      });

      const isValid = typeof result === 'object' && result !== null
        ? Boolean((result as { valid?: boolean }).valid)
        : true;

      if (!isValid) {
        throw new MoltslackClientError('Moltslack token verification failed');
      }
      return true;
    } catch (error) {
      this.enabled = false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Moltslack verification failed: ${message}`);
      return false;
    }
  }

  /**
   * Send a text/system message to Moltslack.
   */
  async sendMessage(request: SendMessageRequest): Promise<void> {
    if (!this.enabled) {
      throw new MoltslackClientError('Moltslack client is disabled');
    }

    const payload: Record<string, unknown> = {
      target: request.target,
      targetType: request.targetType ?? (request.target.startsWith('#') ? 'channel' : 'agent'),
      type: request.type ?? 'text',
      content: {
        text: request.text,
        ...(request.data ? { data: request.data } : {}),
      },
      ...(request.threadId ? { threadId: request.threadId } : {}),
    };

    await this.request('/api/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Low-level request helper that unwraps { data } envelopes.
   */
  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.enabled) {
      throw new MoltslackClientError('Moltslack client is disabled');
    }

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        headers: this.buildHeaders(init.headers),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new MoltslackClientError(
          `Moltslack request failed (${res.status}): ${body || res.statusText}`,
          res.status
        );
      }

      // Some endpoints may return 204/empty bodies
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }

      const json = JSON.parse(text);
      if (json && typeof json === 'object' && 'data' in json) {
        return (json as { data: T }).data;
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildHeaders(input?: RequestInit['headers']): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': `moltlab/${this.agentName}`,
    };

    if (!input) {
      return headers;
    }

    if (input instanceof Headers) {
      for (const [key, value] of input.entries()) {
        headers[key] = value;
      }
      return headers;
    }

    if (Array.isArray(input)) {
      for (const [key, value] of input) {
        headers[key] = String(value);
      }
      return headers;
    }

    for (const [key, value] of Object.entries(input)) {
      headers[key] = Array.isArray(value) ? value.join(',') : String(value);
    }

    return headers;
  }
}

let client: MoltslackClient | null = null;

export function getMoltslackClient(): MoltslackClient | null {
  return client;
}

export async function initMoltslackClient(): Promise<MoltslackClient | null> {
  const disabled = process.env.MOLTSLACK_DISABLED === '1';
  const baseUrl = process.env.MOLTSLACK_URL || process.env.MOLTSLACK_BASE_URL;
  const token = process.env.MOLTSLACK_TOKEN;
  const agentName = process.env.MOLTSLACK_AGENT || 'moltlab';

  if (disabled) {
    console.warn('Moltslack integration disabled via MOLTSLACK_DISABLED=1');
    return null;
  }

  if (!baseUrl || !token) {
    console.warn('Moltslack not configured (MOLTSLACK_URL/MOLTSLACK_TOKEN missing); skipping integration');
    return null;
  }

  const instance = new MoltslackClient({ baseUrl, token, agentName });
  const verified = await instance.verifyToken();
  if (!verified) {
    return null;
  }

  client = instance;

  // Lazily ensure core channels exist (avoids circular import issues)
  try {
    const { ensureDefaultChannels } = await import('./channels.js');
    await ensureDefaultChannels(instance);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Moltslack channel initialization failed: ${message}`);
  }

  return client;
}
