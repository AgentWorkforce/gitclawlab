/**
 * Fly.io Deploy Provider
 * Handles deployments to Fly.io
 */

import { execa } from 'execa';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { DeployOptions, DeployResult, ProviderStatus, MoltlabConfig } from '../types.js';

/**
 * Check if Fly CLI is installed and authenticated
 */
export async function checkFlyStatus(): Promise<ProviderStatus> {
  try {
    // Check if flyctl is installed
    const { stdout: versionOutput } = await execa('flyctl', ['version']);
    const version = versionOutput.match(/flyctl v([\d.]+)/)?.[1] || versionOutput.trim();

    // Check if authenticated
    try {
      await execa('flyctl', ['auth', 'whoami'], { timeout: 10000 });
      return { installed: true, authenticated: true, version };
    } catch {
      return { installed: true, authenticated: false, version };
    }
  } catch {
    return { installed: false, authenticated: false };
  }
}

/**
 * Generate a fly.toml configuration file
 */
function generateFlyToml(appName: string, config?: MoltlabConfig): string {
  const port = config?.deploy?.port || 3000;
  const region = config?.deploy?.region || 'iad';

  return `app = "${appName}"
primary_region = "${region}"

[build]

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1

[checks]
  [checks.health]
    type = "http"
    port = ${port}
    path = "${config?.deploy?.healthcheck || '/health'}"
    interval = "10s"
    timeout = "2s"
    grace_period = "5s"
`;
}

/**
 * Ensure fly.toml exists in the repo
 */
function ensureFlyToml(repoPath: string, appName: string, config?: MoltlabConfig): void {
  const flyTomlPath = join(repoPath, 'fly.toml');

  if (!existsSync(flyTomlPath)) {
    const content = generateFlyToml(appName, config);
    writeFileSync(flyTomlPath, content, 'utf-8');
  }
}

/**
 * Create a new Fly app
 */
async function createFlyApp(
  appName: string,
  repoPath: string,
  region: string,
  logs: string[]
): Promise<{ success: boolean; error?: string }> {
  logs.push(`Creating Fly app: ${appName}`);

  try {
    await execa('flyctl', ['apps', 'create', appName, '--org', 'personal'], {
      cwd: repoPath,
      timeout: 30000,
    });
    logs.push(`Created Fly app: ${appName}`);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Check if app already exists
    if (errorMessage.includes('already exists')) {
      logs.push(`App ${appName} already exists, using existing app`);
      return { success: true };
    }

    return { success: false, error: errorMessage };
  }
}

/**
 * Set secrets on a Fly app
 */
async function setFlySecrets(
  appName: string,
  env: Record<string, string>,
  logs: string[]
): Promise<void> {
  if (Object.keys(env).length === 0) {
    return;
  }

  logs.push('Setting Fly secrets...');

  const secretArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);

  try {
    await execa('flyctl', ['secrets', 'set', ...secretArgs, '-a', appName], {
      timeout: 30000,
    });
    logs.push(`Set ${Object.keys(env).length} secrets`);
  } catch (error) {
    logs.push(`Warning: Failed to set some secrets - ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deploy to Fly.io
 */
export async function deployToFly(options: DeployOptions): Promise<DeployResult> {
  const { repoPath, appName, config, env = {} } = options;
  const logs: string[] = [];
  const region = config?.deploy?.region || 'iad';

  logs.push('Starting Fly.io deployment...');

  // Check Fly CLI status
  const status = await checkFlyStatus();
  if (!status.installed) {
    return {
      success: false,
      error: 'Fly CLI not installed. Install with: curl -L https://fly.io/install.sh | sh',
      logs: [...logs, 'ERROR: Fly CLI (flyctl) not installed'],
    };
  }

  if (!status.authenticated) {
    return {
      success: false,
      error: 'Fly CLI not authenticated. Run: flyctl auth login',
      logs: [...logs, 'ERROR: Fly CLI not authenticated'],
    };
  }

  logs.push(`Fly CLI version: ${status.version}`);

  // Create app if needed
  const createResult = await createFlyApp(appName, repoPath, region, logs);
  if (!createResult.success) {
    return {
      success: false,
      error: createResult.error,
      logs,
    };
  }

  // Ensure fly.toml exists
  ensureFlyToml(repoPath, appName, config);
  logs.push('Ensured fly.toml configuration');

  // Set secrets
  if (Object.keys(env).length > 0) {
    await setFlySecrets(appName, env, logs);
  }

  // Deploy
  logs.push('Deploying to Fly.io...');

  try {
    const deployProcess = execa('flyctl', ['deploy', '--remote-only', '--now'], {
      cwd: repoPath,
      timeout: 600000, // 10 minute timeout
    });

    deployProcess.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) logs.push(line);
    });

    deployProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) logs.push(line);
    });

    await deployProcess;

    // Get the deployment URL
    const deployedUrl = `https://${appName}.fly.dev`;
    logs.push(`Deployed successfully: ${deployedUrl}`);

    return {
      success: true,
      url: deployedUrl,
      logs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logs.push(`ERROR: Deployment failed - ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
      logs,
    };
  }
}

/**
 * Get status of a Fly app
 */
export async function getFlyAppStatus(appName: string): Promise<{
  running: boolean;
  url?: string;
  error?: string;
}> {
  try {
    const { stdout } = await execa('flyctl', ['status', '-a', appName, '--json'], {
      timeout: 15000,
    });

    const status = JSON.parse(stdout);
    const running = status.Machines?.some((m: { state: string }) => m.state === 'started');

    return {
      running: !!running,
      url: `https://${appName}.fly.dev`,
    };
  } catch (error) {
    return {
      running: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Delete a Fly app
 */
export async function deleteFlyApp(appName: string): Promise<boolean> {
  try {
    await execa('flyctl', ['apps', 'destroy', appName, '-y'], {
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scale a Fly app
 */
export async function scaleFlyApp(
  appName: string,
  count: number,
  memory?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const args = ['scale', 'count', count.toString(), '-a', appName];
    await execa('flyctl', args, { timeout: 30000 });

    if (memory) {
      await execa('flyctl', ['scale', 'memory', memory, '-a', appName], {
        timeout: 30000,
      });
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
