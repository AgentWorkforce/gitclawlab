/**
 * Deploy Engine
 * Main orchestrator for MoltLab deployments
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import { ulid } from 'ulid';
import type { DeployOptions, DeployResult, MoltlabConfig, DeployProvider, ProviderStatus } from './types.js';
import { checkDocker, hasDockerfile, buildImage, removeImage } from './docker.js';
import { checkRailwayStatus, deployToRailway } from './providers/railway.js';
import { checkFlyStatus, deployToFly } from './providers/fly.js';
import { notifyDeployment, notifyBuildError } from '../moltslack/notifications.js';

export interface DeployEngineOptions {
  repoPath: string;
  commitSha?: string;
  provider?: DeployProvider;
  appName?: string;
  env?: Record<string, string>;
  customDomain?: string;
}

export interface DeployEngineResult {
  deploymentId: string;
  success: boolean;
  url?: string;
  customDomain?: string;
  error?: string;
  logs: string[];
  provider: DeployProvider;
}

/**
 * Parse moltlab.yaml config from repo
 */
export function parseConfig(repoPath: string): MoltlabConfig | null {
  const configPaths = ['moltlab.yaml', 'moltlab.yml', '.moltlab.yaml', '.moltlab.yml'];

  for (const configPath of configPaths) {
    const fullPath = join(repoPath, configPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        return YAML.parse(content) as MoltlabConfig;
      } catch (error) {
        console.error(`Failed to parse ${configPath}:`, error);
      }
    }
  }

  return null;
}

/**
 * Detect the best deployment provider
 */
async function detectProvider(repoPath: string): Promise<DeployProvider | undefined> {
  // Check Railway first
  const railwayStatus = await checkRailwayStatus();
  if (railwayStatus.installed && railwayStatus.authenticated) {
    return 'railway';
  }

  // Fall back to Fly.io
  const flyStatus = await checkFlyStatus();
  if (flyStatus.installed && flyStatus.authenticated) {
    return 'fly';
  }

  return undefined;
}

/**
 * Generate a valid app name from repo name
 */
function sanitizeAppName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/**
 * Check deployment prerequisites
 */
export async function checkPrerequisites(): Promise<{
  docker: { installed: boolean; running: boolean; version?: string };
  railway: ProviderStatus;
  fly: ProviderStatus;
}> {
  const [docker, railway, fly] = await Promise.all([
    checkDocker(),
    checkRailwayStatus(),
    checkFlyStatus(),
  ]);

  return { docker, railway, fly };
}

/**
 * Main deployment function
 */
export async function deploy(options: DeployEngineOptions): Promise<DeployEngineResult> {
  const deploymentId = ulid();
  const logs: string[] = [];

  logs.push(`Starting deployment ${deploymentId}`);
  logs.push(`Repository: ${options.repoPath}`);

  // Validate repo path
  if (!existsSync(options.repoPath)) {
    return {
      deploymentId,
      success: false,
      error: `Repository path not found: ${options.repoPath}`,
      logs: [...logs, 'ERROR: Repository path not found'],
      provider: options.provider || 'fly',
    };
  }

  // Parse config
  const config = parseConfig(options.repoPath);
  if (config) {
    logs.push(`Found moltlab.yaml: ${config.name}`);
  }

  // Determine provider
  const configTarget = config?.deploy?.provider ?? config?.deploy?.target;
  let provider: DeployProvider | undefined = options.provider;
  if (!provider && configTarget) {
    provider = configTarget === 'fly' ? 'fly' : 'railway';
  }

  if (!provider) {
    logs.push('No provider specified, auto-detecting...');
    provider = await detectProvider(options.repoPath);

    if (!provider) {
      return {
        deploymentId,
        success: false,
        error: 'No deployment provider available. Install and authenticate Railway CLI or Fly CLI.',
        logs: [...logs, 'ERROR: No deployment provider available'],
        provider: 'fly',
      };
    }
    logs.push(`Auto-detected provider: ${provider}`);
  }

  // Generate app name
  const appName = options.appName || sanitizeAppName(config?.name || `moltlab-${deploymentId.slice(0, 8).toLowerCase()}`);
  logs.push(`App name: ${appName}`);

  // Check for Dockerfile
  const hasDocker = hasDockerfile(options.repoPath);
  logs.push(`Dockerfile present: ${hasDocker}`);

  // Check Docker if Dockerfile exists (for local builds)
  let dockerStatus: { installed: boolean; running: boolean; version?: string } | undefined;
  if (hasDocker) {
    dockerStatus = await checkDocker();
    logs.push(`Docker installed: ${dockerStatus.installed}, running: ${dockerStatus.running}`);
  }

  // Build Docker image up-front when possible so Railway receives a known-good image
  let builtImageTag: string | undefined;
  if (hasDocker) {
    if (dockerStatus?.installed && dockerStatus.running) {
      const imageName = `moltlab/${appName}`;
      const tag = (options.commitSha || deploymentId).slice(0, 12);
      const buildResult = await buildImage({
        repoPath: options.repoPath,
        imageName,
        tag,
      });

      logs.push(...buildResult.logs);

      if (!buildResult.success) {
        const errorMessage = buildResult.error || 'Docker build failed';
        logs.push(`Deployment ${deploymentId} failed before deploy: ${errorMessage}`);
        try {
          await notifyBuildError(appName, errorMessage);
        } catch (err) {
          logs.push(`Notification failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        return {
          deploymentId,
          success: false,
          error: errorMessage,
          logs,
          provider,
        };
      }

      builtImageTag = buildResult.imageTag;
    } else {
      logs.push('Skipping local Docker build: Docker is not installed or not running. Railway will build remotely.');
    }
  } else {
    logs.push('No Dockerfile found; Railway will fall back to Nixpacks build.');
  }

  // Determine custom domain (explicit customDomain takes precedence over subdomain config)
  const customDomain = options.customDomain || config?.deploy?.customDomain || config?.deploy?.subdomain;

  // Build deploy options
  const deployOptions: DeployOptions = {
    repoPath: options.repoPath,
    commitSha: options.commitSha || 'HEAD',
    provider,
    appName,
    config: config || undefined,
    env: {
      ...config?.deploy?.env,
      ...options.env,
    },
    customDomain,
  };

  // Deploy based on provider
  let result: DeployResult;

    if (provider === 'railway') {
      logs.push('Deploying to Railway...');
      result = await deployToRailway(deployOptions);
  } else if (provider === 'fly') {
    logs.push('Deploying to Fly.io...');
    result = await deployToFly(deployOptions);
  } else {
    return {
      deploymentId,
      success: false,
      error: `Unknown provider: ${provider}`,
      logs: [...logs, `ERROR: Unknown provider: ${provider}`],
      provider,
    };
  }

  // Merge logs
  logs.push(...result.logs);

  if (result.success) {
    logs.push(`Deployment ${deploymentId} completed successfully`);
    if (result.url) {
      logs.push(`Deployed URL: ${result.url}`);
    }
    if (result.customDomain) {
      logs.push(`Custom Domain: https://${result.customDomain}`);
    }
    try {
      const notifyUrl = result.customDomain ? `https://${result.customDomain}` : result.url || 'unknown';
      await notifyDeployment(appName, notifyUrl);
    } catch (err) {
      logs.push(`Notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    logs.push(`Deployment ${deploymentId} failed: ${result.error}`);
    try {
      await notifyBuildError(appName, result.error);
    } catch (err) {
      logs.push(`Notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Clean up built image to avoid disk bloat on shared runners
  if (builtImageTag) {
    await removeImage(builtImageTag).catch(() => {
      /* best effort cleanup */
    });
  }

  return {
    deploymentId,
    success: result.success,
    url: result.url,
    customDomain: result.customDomain,
    error: result.error,
    logs,
    provider,
  };
}

/**
 * Quick deploy helper - parses config and deploys with minimal options
 */
export async function quickDeploy(repoPath: string, provider?: DeployProvider): Promise<DeployEngineResult> {
  return deploy({ repoPath, provider });
}

// Re-export types and utilities
export type { DeployOptions, DeployResult, MoltlabConfig, DeployProvider, ProviderStatus } from './types.js';
export { checkDocker, hasDockerfile, buildImage } from './docker.js';
export { checkRailwayStatus, deployToRailway } from './providers/railway.js';
export { checkFlyStatus, deployToFly } from './providers/fly.js';
