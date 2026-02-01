/**
 * Railway Deploy Provider
 * Handles deployments to Railway.app
 */

import { execa } from 'execa';
import type { DeployOptions, DeployResult, ProviderStatus } from '../types.js';

/**
 * Check if Railway CLI is installed and authenticated
 */
export async function checkRailwayStatus(): Promise<ProviderStatus> {
  try {
    // Check if railway CLI is installed
    const { stdout: versionOutput } = await execa('railway', ['--version']);
    const version = versionOutput.trim();

    // Check if authenticated
    try {
      await execa('railway', ['whoami'], { timeout: 10000 });
      return { installed: true, authenticated: true, version };
    } catch {
      return { installed: true, authenticated: false, version };
    }
  } catch {
    return { installed: false, authenticated: false };
  }
}

/**
 * Create a new Railway project and link to it
 * Uses `railway init` which creates and links in one step
 */
async function createProject(
  appName: string,
  repoPath: string,
  logs: string[]
): Promise<{ success: boolean; projectId?: string; error?: string }> {
  try {
    // railway init creates a new project and links to it
    const { stdout, stderr } = await execa('railway', ['init', '--name', appName], {
      cwd: repoPath,
      timeout: 30000,
      env: {
        ...process.env,
        // Ensure non-interactive mode
        CI: 'true',
      },
    });

    logs.push(`Railway init output: ${stdout}`);
    if (stderr) logs.push(`Railway init stderr: ${stderr}`);

    // Extract project ID from output
    const projectIdMatch = stdout.match(/Project ID: ([a-f0-9-]+)/i) ||
                          stdout.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    return {
      success: true,
      projectId: projectIdMatch?.[1],
    };
  } catch (error: any) {
    const errorMsg = error.stderr || error.message || 'Failed to create Railway project';
    logs.push(`Railway init error: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Ensure a Railway project exists for deployment
 * Creates a new project if needed (each app gets its own Railway project)
 */
async function ensureProject(
  appName: string,
  repoPath: string,
  logs: string[]
): Promise<{ success: boolean; projectId?: string; error?: string }> {
  logs.push(`Setting up Railway project for: ${appName}`);

  // Check if RAILWAY_TOKEN is set for authentication
  if (!process.env.RAILWAY_TOKEN) {
    logs.push('Warning: RAILWAY_TOKEN not set - using local credentials');
  }

  // Always create a new project for each app
  // This ensures each deployed app has its own isolated Railway project
  const result = await createProject(appName, repoPath, logs);

  if (result.success) {
    logs.push(`Railway project ready: ${result.projectId || appName}`);
  }

  return result;
}

/**
 * Set environment variables on Railway
 */
async function setEnvironmentVariables(
  env: Record<string, string>,
  repoPath: string,
  logs: string[]
): Promise<void> {
  for (const [key, value] of Object.entries(env)) {
    try {
      await execa('railway', ['variables', 'set', `${key}=${value}`], {
        cwd: repoPath,
        timeout: 10000,
      });
      logs.push(`Set env var: ${key}`);
    } catch (error) {
      logs.push(`Warning: Failed to set env var ${key}`);
    }
  }
}

/**
 * Deploy to Railway
 */
export async function deployToRailway(options: DeployOptions): Promise<DeployResult> {
  const { repoPath, appName, env = {}, customDomain } = options;
  const logs: string[] = [];

  logs.push('Starting Railway deployment...');

  // Check Railway CLI status
  const status = await checkRailwayStatus();
  if (!status.installed) {
    return {
      success: false,
      error: 'Railway CLI not installed. Install with: npm install -g @railway/cli',
      logs: [...logs, 'ERROR: Railway CLI not installed'],
    };
  }

  if (!status.authenticated) {
    return {
      success: false,
      error: 'Railway CLI not authenticated. Run: railway login',
      logs: [...logs, 'ERROR: Railway CLI not authenticated'],
    };
  }

  logs.push(`Railway CLI version: ${status.version}`);

  // Ensure project exists
  const projectResult = await ensureProject(appName, repoPath, logs);
  if (!projectResult.success) {
    return {
      success: false,
      error: projectResult.error,
      logs,
    };
  }

  // Set environment variables
  if (Object.keys(env).length > 0) {
    logs.push('Setting environment variables...');
    await setEnvironmentVariables(env, repoPath, logs);
  }

  // Deploy using Railway's built-in Nixpacks or Dockerfile
  logs.push('Deploying to Railway...');

  try {
    const deployProcess = execa('railway', ['up', '--detach'], {
      cwd: repoPath,
      timeout: 600000, // 10 minute timeout
    });

    deployProcess.stdout?.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    deployProcess.stderr?.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    const { stdout } = await deployProcess;

    // Extract deployment URL from output
    const urlMatch = stdout.match(/https?:\/\/[^\s]+\.railway\.app[^\s]*/);
    const deployedUrl = urlMatch?.[0];

    let railwayUrl = deployedUrl;

    // If no URL in output, try to get the domain
    if (!railwayUrl) {
      try {
        const { stdout: domainOutput } = await execa('railway', ['domain'], {
          cwd: repoPath,
          timeout: 10000,
        });
        const domain = domainOutput.trim();
        if (domain) {
          railwayUrl = domain.startsWith('http') ? domain : `https://${domain}`;
        }
      } catch {
        // Ignore domain fetch errors
      }
    }

    // Configure custom domain if specified (auto-subdomain for GitClawLab)
    let configuredCustomDomain: string | undefined;
    const domainToAdd = customDomain || generateSubdomain(appName);

    if (domainToAdd) {
      const domainResult = await addCustomDomain(domainToAdd, repoPath, logs);
      if (domainResult.success) {
        configuredCustomDomain = domainToAdd;
        logs.push(`App accessible at: https://${domainToAdd}`);
      }
    }

    if (railwayUrl) {
      logs.push(`Deployed successfully: ${railwayUrl}`);
    } else {
      logs.push('Deployment initiated (Railway URL pending)');
    }

    return {
      success: true,
      url: railwayUrl,
      customDomain: configuredCustomDomain,
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
 * Get the URL for an existing Railway deployment
 */
export async function getRailwayUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execa('railway', ['domain'], {
      cwd: repoPath,
      timeout: 10000,
    });
    const domain = stdout.trim();
    if (domain) {
      return domain.startsWith('http') ? domain : `https://${domain}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete a Railway project
 */
export async function deleteRailwayProject(repoPath: string): Promise<boolean> {
  try {
    await execa('railway', ['down', '-y'], {
      cwd: repoPath,
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Base domain for GitClawLab deployments
 * Apps will be accessible at <app-name>.gitclawlab.com
 */
export const GITCLAWLAB_BASE_DOMAIN = process.env.GITCLAWLAB_BASE_DOMAIN || 'gitclawlab.com';

/**
 * Add a custom domain to a Railway service
 */
export async function addCustomDomain(
  domain: string,
  repoPath: string,
  logs: string[]
): Promise<{ success: boolean; error?: string }> {
  logs.push(`Adding custom domain: ${domain}`);

  try {
    const { stdout } = await execa('railway', ['domain', domain], {
      cwd: repoPath,
      timeout: 30000,
    });
    logs.push(`Custom domain added: ${stdout.trim() || domain}`);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logs.push(`Warning: Failed to add custom domain - ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Generate subdomain for an app name
 */
export function generateSubdomain(appName: string, baseDomain: string = GITCLAWLAB_BASE_DOMAIN): string {
  const sanitized = appName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${sanitized}.${baseDomain}`;
}
