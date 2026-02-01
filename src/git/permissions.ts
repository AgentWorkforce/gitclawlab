import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type AccessLevel = 'read' | 'write' | 'admin';

export interface AgentKey {
  agentId: string;
  publicKey: string;
  label?: string;
  createdAt: string;
  access: AccessLevel;
}

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const dataRoot = path.join(projectRoot, '.moltlab', 'soft-serve');
const registryPath = path.join(dataRoot, 'authorized_keys.json');
const sshDir = path.join(dataRoot, 'ssh');
const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

function ensureBaseDirs(): void {
  fs.mkdirSync(sshDir, { recursive: true });
}

function readRegistry(): AgentKey[] {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as AgentKey[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(keys: AgentKey[]): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(keys, null, 2), 'utf8');
}

export function listAgentKeys(): AgentKey[] {
  return readRegistry();
}

export function addAgentKey(agentId: string, publicKey: string, access: AccessLevel = 'write', label?: string): AgentKey {
  ensureBaseDirs();
  const normalized = publicKey.trim();
  if (!normalized.startsWith('ssh-') && !normalized.startsWith('ecdsa-')) {
    throw new Error('Invalid SSH public key format');
  }

  const keys = readRegistry();
  if (keys.some((k) => k.publicKey === normalized)) {
    return keys.find((k) => k.publicKey === normalized)!;
  }

  const entry: AgentKey = {
    agentId,
    publicKey: normalized,
    label,
    createdAt: new Date().toISOString(),
    access,
  };

  keys.push(entry);
  writeRegistry(keys);
  writeAuthorizedKeys(keys);

  return entry;
}

export function removeAgentKey(agentId: string, publicKey?: string): void {
  const keys = readRegistry().filter((k) => k.agentId !== agentId || (publicKey && k.publicKey !== publicKey));
  writeRegistry(keys);
  writeAuthorizedKeys(keys);
}

export function writeAuthorizedKeys(keys: AgentKey[] = readRegistry()): string {
  ensureBaseDirs();
  const lines = keys.map((k) => {
    const commentParts = [`agent=${k.agentId}`];
    if (k.label) {
      commentParts.push(k.label);
    }
    commentParts.push(`access=${k.access}`);
    return `${k.publicKey} ${commentParts.join(';')}`;
  });

  fs.writeFileSync(authorizedKeysPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  return authorizedKeysPath;
}

export function getAuthorizedKeysPath(): string {
  ensureBaseDirs();
  return authorizedKeysPath;
}

export function getAdminKeyEnv(): string | undefined {
  const keys = readRegistry().filter((k) => k.access === 'admin');
  if (!keys.length) return undefined;
  return keys.map((k) => k.publicKey.trim()).join(',');
}

export function getDataRoot(): string {
  return dataRoot;
}
