import fs from 'fs';
import path from 'path';
import { execa, ExecaChildProcess } from 'execa';
import { installPostReceiveHook } from './hooks.js';
import { addAgentKey, getAdminKeyEnv, getAuthorizedKeysPath, getDataRoot, writeAuthorizedKeys } from './permissions.js';

export interface GitServerOptions {
  port: number;
  host?: string;
  httpPort?: number;
  dataPath?: string;
}

let softServeProcess: ExecaChildProcess | null = null;
let resolvedBinary: string | null = null;

export async function initGitServer(options: GitServerOptions): Promise<void> {
  if (softServeProcess) return;

  const binary = await resolveSoftServeBinary();
  if (!binary) {
    const instructions = [
      'soft-serve binary not found.',
      'Install with one of:',
      '  - brew install charmbracelet/tap/soft-serve',
      '  - or visit https://github.com/charmbracelet/soft-serve for downloads',
    ].join('\n');
    throw new Error(instructions);
  }

  const dataPath = options.dataPath ?? getDataRoot();
  const reposPath = path.join(dataPath, 'repos');
  fs.mkdirSync(reposPath, { recursive: true });
  writeAuthorizedKeys(); // ensure authorized_keys exists even if empty

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOFT_SERVE_DATA_PATH: dataPath,
    SOFT_SERVE_SSH_LISTEN_ADDR: `${options.host ?? '0.0.0.0'}:${options.port}`,
    SOFT_SERVE_HTTP_LISTEN_ADDR: `${options.host ?? '0.0.0.0'}:${options.httpPort ?? 23232}`,
    SOFT_SERVE_INITIAL_ADMIN_KEYS_FILE: getAuthorizedKeysPath(),
  };

  const adminKeys = getAdminKeyEnv();
  if (adminKeys) {
    env.SOFT_SERVE_INITIAL_ADMIN_KEYS = adminKeys;
  }

  softServeProcess = execa(binary, ['serve'], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  softServeProcess.stdout?.on('data', (buf) => {
    process.stdout.write(`[soft-serve] ${buf.toString()}`);
  });

  softServeProcess.stderr?.on('data', (buf) => {
    process.stderr.write(`[soft-serve] ${buf.toString()}`);
  });

  softServeProcess.on('exit', (code) => {
    console.log(`soft-serve exited with code ${code ?? 0}`);
    softServeProcess = null;
  });
}

export async function stopGitServer(): Promise<void> {
  if (softServeProcess) {
    softServeProcess.kill('SIGTERM', {
      forceKillAfterTimeout: 2000,
    });
    softServeProcess = null;
  }
}

export async function createBareRepository(name: string): Promise<string> {
  const repoName = sanitizeRepoName(name);
  if (!repoName) {
    throw new Error('Repository name is required');
  }
  const dataPath = getDataRoot();
  const reposPath = path.join(dataPath, 'repos');
  fs.mkdirSync(reposPath, { recursive: true });

  const repoPath = path.join(reposPath, `${repoName}.git`);
  if (!fs.existsSync(repoPath)) {
    await execa('git', ['init', '--bare', repoPath]);
  }

  await installPostReceiveHook(repoPath);
  return repoPath;
}

export async function ensureAgentKey(agentId: string, publicKey: string): Promise<void> {
  addAgentKey(agentId, publicKey, 'write');
}

export function getRepositoriesPath(): string {
  const dataPath = getDataRoot();
  return path.join(dataPath, 'repos');
}

export interface RepositoryInfo {
  name: string;
  path: string;
  defaultBranch: string;
}

export async function createRepository(name: string): Promise<RepositoryInfo> {
  const repoPath = await createBareRepository(name);

  // Ensure HEAD points to main for consistency with the CLI UX
  try {
    await execa('git', ['--git-dir', repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  } catch {
    // Best effort; continue if symbolic-ref fails
  }

  return {
    name: path.basename(repoPath).replace(/\.git$/, ''),
    path: repoPath,
    defaultBranch: 'main',
  };
}

export async function listRepositories(): Promise<RepositoryInfo[]> {
  const reposPath = getRepositoriesPath();
  if (!fs.existsSync(reposPath)) return [];

  return fs
    .readdirSync(reposPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && dirent.name.endsWith('.git'))
    .map((dirent) => {
      const repoPath = path.join(reposPath, dirent.name);
      return {
        name: dirent.name.replace(/\.git$/, ''),
        path: repoPath,
        defaultBranch: 'main',
      };
    });
}

export async function getRepositoryInfo(name: string): Promise<RepositoryInfo | null> {
  const normalized = name.replace(/\.git$/, '');
  const matches = (await listRepositories()).filter((repo) => repo.name === normalized);
  return matches.length ? matches[0] : null;
}

function sanitizeRepoName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .replace(/\.git$/, '');
}

async function resolveSoftServeBinary(): Promise<string | null> {
  if (resolvedBinary) return resolvedBinary;

  const candidates = ['soft', 'soft-serve'];
  for (const bin of candidates) {
    try {
      const result = await execa(bin, ['--version']);
      if (result.exitCode === 0) {
        resolvedBinary = bin;
        return bin;
      }
    } catch {
      // continue searching
    }
  }

  return null;
}
