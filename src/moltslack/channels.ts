import { MoltslackClient, getMoltslackClient } from './client.js';

export type ChannelType = 'public' | 'private' | 'direct' | 'broadcast';

export interface ChannelMetadata {
  displayName?: string;
  topic?: string;
  purpose?: string;
  isArchived?: boolean;
  allowExternal?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  metadata?: ChannelMetadata;
  defaultAccess?: 'read' | 'write' | 'admin' | null;
}

export interface CreateChannelOptions {
  type?: ChannelType;
  metadata?: ChannelMetadata;
  defaultAccess?: 'read' | 'write' | 'admin' | null;
  accessRules?: Array<{
    principal: string;
    principalType: 'agent' | 'role' | 'all';
    level: 'read' | 'write' | 'admin';
    expiresAt?: string;
  }>;
}

const channelCache = new Map<string, Channel>();

const DEFAULT_CHANNELS: Array<{ name: string; options: CreateChannelOptions }> = [
  {
    name: '#repos',
    options: {
      type: 'public',
      defaultAccess: 'write',
      metadata: {
        displayName: 'Repositories',
        topic: 'Repository push activity',
        purpose: 'Mirror git pushes from MoltLab',
      },
    },
  },
  {
    name: '#deployments',
    options: {
      type: 'public',
      defaultAccess: 'write',
      metadata: {
        displayName: 'Deployments',
        topic: 'Deployment notifications from MoltLab',
        purpose: 'Track deployments and URLs',
      },
    },
  },
  {
    name: '#errors',
    options: {
      type: 'public',
      defaultAccess: 'write',
      metadata: {
        displayName: 'Errors',
        topic: 'Build and deployment failures',
        purpose: 'Surface failing pipelines',
      },
    },
  },
];

function normalizeName(name: string): string {
  return name.startsWith('#') ? name : `#${name}`;
}

export async function listChannels(client = getMoltslackClient()): Promise<Channel[]> {
  if (!client || !client.isEnabled()) {
    return [];
  }

  try {
    const channels = await client.request<Channel[]>('/api/v1/channels');
    return Array.isArray(channels) ? channels : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to list Moltslack channels: ${message}`);
    return [];
  }
}

export async function findChannelByName(
  name: string,
  client = getMoltslackClient()
): Promise<Channel | null> {
  const normalized = normalizeName(name);
  const cached = channelCache.get(normalized);
  if (cached) {
    return cached;
  }

  const channels = await listChannels(client);
  const match = channels.find((ch) => ch.name === normalized);
  if (match) {
    channelCache.set(normalized, match);
    return match;
  }
  return null;
}

export async function createChannel(
  name: string,
  options: CreateChannelOptions = {},
  client = getMoltslackClient()
): Promise<Channel | null> {
  if (!client || !client.isEnabled()) {
    return null;
  }

  const normalized = normalizeName(name);
  const payload = {
    name: normalized,
    type: options.type ?? 'public',
    metadata: options.metadata ?? {},
    defaultAccess: options.defaultAccess ?? 'write',
    ...(options.accessRules ? { accessRules: options.accessRules } : {}),
  };

  try {
    const channel = await client.request<Channel>('/api/v1/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (channel) {
      channelCache.set(normalized, channel);
    }
    return channel;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to create Moltslack channel ${normalized}: ${message}`);
    return null;
  }
}

export async function ensureChannel(
  name: string,
  options: CreateChannelOptions = {},
  client = getMoltslackClient()
): Promise<Channel | null> {
  const normalized = normalizeName(name);

  const existing = await findChannelByName(normalized, client);
  if (existing) {
    return existing;
  }

  return createChannel(normalized, options, client);
}

export async function ensureDefaultChannels(
  client: MoltslackClient | null = getMoltslackClient()
): Promise<Channel[]> {
  if (!client || !client.isEnabled()) {
    return [];
  }

  const results: Channel[] = [];
  for (const entry of DEFAULT_CHANNELS) {
    const channel = await ensureChannel(entry.name, entry.options, client);
    if (channel) {
      results.push(channel);
    }
  }
  return results;
}
