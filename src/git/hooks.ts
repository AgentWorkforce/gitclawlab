import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import YAML from 'yaml';
import { createDeployment, getRepository, updateDeployment, updateRepositoryByName } from '../db/schema.js';
import { notifyPush, notifyBuildError } from '../moltslack/notifications.js';
import { deploy, type DeployProvider } from '../deploy/engine.js';
import type { MoltlabConfig } from '../deploy/types.js';

export interface ReceiveUpdate {
  oldRevision: string;
  newRevision: string;
  ref: string;
}

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const distHookPath = path.join(projectRoot, 'dist', 'git', 'hooks.js');
const srcHookPath = path.join(projectRoot, 'src', 'git', 'hooks.ts');

export async function installPostReceiveHook(repoPath: string): Promise<void> {
  const hooksDir = path.join(repoPath, 'hooks');
  await fs.promises.mkdir(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'post-receive');
  const script = `#!/usr/bin/env bash
set -euo pipefail
repo_path="$(pwd)"
if [ -f "${distHookPath}" ]; then
  node "${distHookPath}" post-receive "$repo_path"
elif command -v tsx >/dev/null 2>&1 && [ -f "${srcHookPath}" ]; then
  tsx "${srcHookPath}" post-receive "$repo_path"
else
  echo "moltlab: post-receive handler missing (looked for ${distHookPath} and ${srcHookPath})" >&2
fi
`;

  await fs.promises.writeFile(hookPath, script, { mode: 0o755 });
}

export async function handlePostReceive(repoPath: string, updates: ReceiveUpdate[]): Promise<void> {
  if (!updates.length) return;

  const repoName = path.basename(repoPath).replace(/\.git$/, '');
  const now = new Date().toISOString();

  try {
    await updateRepositoryByName(repoName, { last_push_at: now, updated_at: now });
  } catch (err) {
    console.warn(`moltlab: could not update push timestamp for ${repoName}`, err);
  }

  try {
    await notifyPush(repoName, 'Agent');
  } catch (err) {
    console.warn(`moltlab: failed to send push notification for ${repoName}`, err);
  }

  for (const update of updates) {
    if (update.newRevision === '0000000000000000000000000000000000000000') continue;
    if (!update.ref.startsWith('refs/heads/')) continue;

    const branch = update.ref.replace('refs/heads/', '');
    const config = await readMoltlabConfig(repoPath, update.newRevision);
    if (!config) {
      continue;
    }

    let repo;
    try {
      repo = await getRepository(repoName);
    } catch (err) {
      console.warn(`moltlab: database unavailable while handling push for ${repoName}`, err);
      continue;
    }
    if (!repo) {
      console.warn(`moltlab: received push for unknown repo ${repoName}`);
      continue;
    }

    const targetRaw = config.deploy?.target || 'railway';
    const target: DeployProvider = targetRaw === 'fly' ? 'fly' : 'railway';
    try {
      const deployment = await createDeployment(repo.id, update.newRevision, target, 'git-hook');
      console.log(`[deploy] queued ${repoName}@${update.newRevision.slice(0, 7)} (${branch}) to ${deployment.target}`);

      // Materialize the pushed commit into a temp worktree so the deploy engine can build it
      const { workdir, cleanup } = await materializeRevision(repoPath, update.newRevision);

      // Mark deployment as building
      await updateDeployment(deployment.id, { status: 'building' });

      try {
        // Kick off deployment (build + Railway CLI) from the checked-out tree
        await updateDeployment(deployment.id, { status: 'deploying' });
        const result = await deploy({
          repoPath: workdir,
          commitSha: update.newRevision,
          provider: target,
          appName: config?.name || `${repoName}-${branch}`,
          env: config.deploy?.env,
        });

        await updateDeployment(deployment.id, {
          status: result.success ? 'success' : 'failed',
          url: result.url ?? null,
          logs: result.logs.join('\n'),
          completed_at: new Date().toISOString(),
        });
      } catch (deployErr) {
        const message = deployErr instanceof Error ? deployErr.message : String(deployErr);
        await updateDeployment(deployment.id, {
          status: 'failed',
          logs: `${message}\n`,
          completed_at: new Date().toISOString(),
        });
        try {
          await notifyBuildError(repoName, message);
        } catch (notifyErr) {
          console.warn(`moltlab: failed to send error notification for ${repoName}`, notifyErr);
        }
      } finally {
        await cleanup();
      }
    } catch (err) {
      console.error(`moltlab: failed to create deployment for ${repoName}`, err);
      try {
        await notifyBuildError(repoName, err instanceof Error ? err.message : String(err));
      } catch (notifyErr) {
        console.warn(`moltlab: failed to send error notification for ${repoName}`, notifyErr);
      }
    }
  }
}

export async function readUpdatesFromStdin(): Promise<ReceiveUpdate[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return [];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [oldRevision, newRevision, ref] = line.split(/\s+/);
      return { oldRevision, newRevision, ref };
    });
}

async function readMoltlabConfig(repoPath: string, revision: string): Promise<MoltlabConfig | null> {
  try {
    const { stdout } = await execa('git', ['--git-dir', repoPath, 'show', `${revision}:moltlab.yaml`]);
    return YAML.parse(stdout) as MoltlabConfig;
  } catch {
    return null;
  }
}

/**
 * Check out a bare git revision into a temporary working directory for building/deploying.
 */
async function materializeRevision(
  bareRepoPath: string,
  commitSha: string
): Promise<{ workdir: string; cleanup: () => Promise<void> }> {
  const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'moltlab-deploy-'));
  const archivePath = path.join(workdir, 'source.tar');

  // Create tar archive of the commit contents
  await execa('git', ['--git-dir', bareRepoPath, 'archive', commitSha, '-o', archivePath]);

  // Extract into workdir
  await execa('tar', ['-xf', archivePath, '-C', workdir]);

  // Remove archive after extraction
  await fs.promises.rm(archivePath, { force: true });

  return {
    workdir,
    cleanup: async () => {
      await fs.promises.rm(workdir, { recursive: true, force: true });
    },
  };
}

// Allow execution when invoked directly by the git hook.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , hookName, repoPath = process.cwd()] = process.argv;
  if (hookName === 'post-receive') {
    readUpdatesFromStdin()
      .then((updates) => handlePostReceive(repoPath, updates))
      .catch((err) => {
        console.error('moltlab: post-receive handler failed', err);
        process.exit(1);
      });
  }
}
