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

    // Check for token-based auth first (CI/CD mode)
    // Project tokens don't work with `railway whoami`
    if (process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN) {
      return { installed: true, authenticated: true, version };
    }

    // Fall back to checking interactive login
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
 * Deploy apps as services within the GitClawLab Railway project.
 * Each app becomes a separate service in the same project.
 */

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

/**
 * Create a service in Railway via API
 */
async function createService(
  projectId: string,
  serviceName: string,
  logs: string[]
): Promise<{ success: boolean; serviceId?: string; error?: string }> {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!token) {
    return { success: false, error: 'No Railway token available' };
  }

  logs.push(`Creating service: ${serviceName}`);

  try {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `
          mutation ServiceCreate($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
              name
            }
          }
        `,
        variables: {
          input: {
            projectId,
            name: serviceName,
          },
        },
      }),
    });

    const data = await response.json() as any;

    if (data.errors) {
      const errorMsg = data.errors[0]?.message || 'Unknown API error';
      logs.push(`Service creation error: ${errorMsg}`);
      // If service already exists, that's okay
      if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
        logs.push('Service already exists, continuing...');
        return { success: true };
      }
      return { success: false, error: errorMsg };
    }

    const serviceId = data.data?.serviceCreate?.id;
    logs.push(`Service created: ${serviceId}`);
    return { success: true, serviceId };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logs.push(`Failed to create service: ${errorMsg}`);
    return { success: false, error: errorMsg };
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

  // Get project ID from environment
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!projectId) {
    return {
      success: false,
      error: 'RAILWAY_PROJECT_ID not set',
      logs: [...logs, 'ERROR: RAILWAY_PROJECT_ID not set'],
    };
  }

  // Create service via API first (CLI can't create services)
  const serviceResult = await createService(projectId, appName, logs);
  if (!serviceResult.success) {
    return {
      success: false,
      error: serviceResult.error || 'Failed to create service',
      logs,
    };
  }

  logs.push(`Deploying as service: ${appName}`);

  // Set environment variables for the service
  if (Object.keys(env).length > 0) {
    logs.push('Setting environment variables...');
    for (const [key, value] of Object.entries(env)) {
      try {
        await execa('railway', ['variables', 'set', `${key}=${value}`, '--service', appName], {
          cwd: repoPath,
          timeout: 10000,
          env: { ...process.env, CI: 'true' },
        });
        logs.push(`Set env var: ${key}`);
      } catch {
        logs.push(`Warning: Failed to set env var ${key}`);
      }
    }
  }

  // Deploy using --service flag to create/update the service
  logs.push('Deploying to Railway...');

  try {
    // Build environment with proper token handling
    // RAILWAY_API_TOKEN works with account tokens, RAILWAY_TOKEN with project tokens
    const deployEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      CI: 'true',
    };

    // If we have RAILWAY_API_TOKEN, use it and clear RAILWAY_TOKEN to avoid conflicts
    if (process.env.RAILWAY_API_TOKEN) {
      deployEnv.RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
      delete deployEnv.RAILWAY_TOKEN;
      logs.push('Using RAILWAY_API_TOKEN for authentication');
    }

    // Build command args - need project ID to deploy to the right project
    const envId = process.env.RAILWAY_ENVIRONMENT_ID;

    const args = ['up', '--detach', '--service', appName];
    if (projectId) {
      args.push('--project', projectId);
      logs.push(`Deploying to project: ${projectId}`);
    }
    if (envId) {
      args.push('--environment', envId);
    }

    const deployProcess = execa('railway', args, {
      cwd: repoPath,
      timeout: 600000, // 10 minute timeout
      env: deployEnv,
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

    // If no URL in output, try to create/get domain via API
    if (!railwayUrl && envId) {
      logs.push('No URL in deployment output, creating service domain via API...');
      const serviceId = await getServiceId(projectId, appName, logs);
      if (serviceId) {
        const domain = await createServiceDomain(serviceId, envId, logs);
        if (domain) {
          railwayUrl = `https://${domain}`;
        }
      }
    }

    // Configure custom domain if specified (auto-subdomain for GitClawLab)
    let configuredCustomDomain: string | undefined;
    const domainToAdd = customDomain || generateSubdomain(appName);

    if (domainToAdd) {
      const domainResult = await addCustomDomain(domainToAdd, repoPath, logs, appName);
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
 * Create a Railway service domain (*.up.railway.app) via API
 */
async function createServiceDomain(
  serviceId: string,
  environmentId: string,
  logs: string[]
): Promise<string | null> {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!token) {
    logs.push('No Railway token for domain creation');
    return null;
  }

  try {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `
          mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
            serviceDomainCreate(input: $input) {
              id
              domain
            }
          }
        `,
        variables: {
          input: {
            serviceId,
            environmentId,
          },
        },
      }),
    });

    const data = await response.json() as any;

    if (data.errors) {
      const errorMsg = data.errors[0]?.message || 'Unknown API error';
      // Domain might already exist
      if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
        logs.push('Service domain already exists');
        return null;
      }
      logs.push(`Service domain creation error: ${errorMsg}`);
      return null;
    }

    const domain = data.data?.serviceDomainCreate?.domain;
    if (domain) {
      logs.push(`Created Railway domain: ${domain}`);
      return domain;
    }
    return null;
  } catch (error) {
    logs.push(`Failed to create service domain: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}

/**
 * Get service ID by name from Railway API
 */
async function getServiceId(
  projectId: string,
  serviceName: string,
  logs: string[]
): Promise<string | null> {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!token) {
    logs.push('No Railway token for service lookup');
    return null;
  }

  try {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `
          query GetProject($projectId: String!) {
            project(id: $projectId) {
              services {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
        variables: { projectId },
      }),
    });

    const data = await response.json() as any;
    const services = data.data?.project?.services?.edges || [];
    const service = services.find((s: any) => s.node.name === serviceName);

    if (service) {
      logs.push(`Found service ID: ${service.node.id}`);
      return service.node.id;
    }

    logs.push(`Service not found: ${serviceName}`);
    return null;
  } catch (error) {
    logs.push(`Failed to get service ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}

/**
 * Add a custom domain to a Railway service via API
 */
export async function addCustomDomain(
  domain: string,
  repoPath: string,
  logs: string[],
  serviceName?: string
): Promise<{ success: boolean; error?: string }> {
  logs.push(`Adding custom domain: ${domain}`);

  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!token) {
    return { success: false, error: 'No Railway token available' };
  }

  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!projectId || !serviceName) {
    return { success: false, error: 'Missing project ID or service name' };
  }

  // Get service ID first
  const serviceId = await getServiceId(projectId, serviceName, logs);
  if (!serviceId) {
    return { success: false, error: 'Could not find service ID' };
  }

  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  try {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `
          mutation CustomDomainCreate($input: CustomDomainCreateInput!) {
            customDomainCreate(input: $input) {
              id
              domain
            }
          }
        `,
        variables: {
          input: {
            domain,
            serviceId,
            environmentId,
          },
        },
      }),
    });

    const data = await response.json() as any;

    if (data.errors) {
      const errorMsg = data.errors[0]?.message || 'Unknown API error';
      logs.push(`Domain API error: ${errorMsg}`);
      // Domain might already exist
      if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
        logs.push('Domain already configured, continuing...');
        return { success: true };
      }
      return { success: false, error: errorMsg };
    }

    logs.push(`Custom domain added via API: ${domain}`);
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

/**
 * Railway deployment status from API
 */
export interface RailwayDeploymentStatus {
  id: string;
  status: 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CRASHED' | 'REMOVED' | 'INITIALIZING' | 'WAITING' | 'QUEUED';
  url?: string;
}

/**
 * Get the latest deployment for a service from Railway API
 */
export async function getLatestRailwayDeployment(
  serviceId: string,
  environmentId: string
): Promise<RailwayDeploymentStatus | null> {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!token) return null;

  try {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `
          query GetDeployments($serviceId: String!, $environmentId: String!) {
            deployments(
              first: 1
              input: { serviceId: $serviceId, environmentId: $environmentId }
            ) {
              edges {
                node {
                  id
                  status
                  staticUrl
                }
              }
            }
          }
        `,
        variables: { serviceId, environmentId },
      }),
    });

    const data = await response.json() as any;
    const deployment = data.data?.deployments?.edges?.[0]?.node;

    if (!deployment) return null;

    return {
      id: deployment.id,
      status: deployment.status,
      url: deployment.staticUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch build logs for a Railway deployment
 */
export async function getRailwayBuildLogs(deploymentId: string): Promise<string | null> {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!token) return null;

  try {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `
          query GetBuildLogs($deploymentId: String!) {
            buildLogs(deploymentId: $deploymentId, limit: 500) {
              message
              timestamp
            }
          }
        `,
        variables: { deploymentId },
      }),
    });

    const data = await response.json() as any;
    const logs = data.data?.buildLogs;

    if (!logs || !Array.isArray(logs)) return null;

    return logs
      .map((log: { message: string; timestamp: string }) => log.message)
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * Poll Railway deployment status until complete or timeout
 * Returns final status with build logs if failed
 */
export async function pollRailwayDeployment(
  projectId: string,
  serviceName: string,
  options: {
    maxWaitMs?: number;
    pollIntervalMs?: number;
    onStatusChange?: (status: string, logs: string[]) => void;
  } = {}
): Promise<{
  success: boolean;
  status: string;
  url?: string;
  buildLogs?: string;
}> {
  const {
    maxWaitMs = 10 * 60 * 1000, // 10 minutes
    pollIntervalMs = 10000, // 10 seconds
    onStatusChange,
  } = options;

  const logs: string[] = [];
  const log = (msg: string) => {
    logs.push(msg);
    onStatusChange?.(msg, logs);
  };

  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!environmentId) {
    return { success: false, status: 'ERROR', buildLogs: 'RAILWAY_ENVIRONMENT_ID not set' };
  }

  // Get service ID
  const serviceId = await getServiceId(projectId, serviceName, logs);
  if (!serviceId) {
    return { success: false, status: 'ERROR', buildLogs: `Service not found: ${serviceName}` };
  }

  log(`Polling deployment status for service: ${serviceName}`);

  const startTime = Date.now();
  let lastStatus = '';
  let deploymentId = '';

  while (Date.now() - startTime < maxWaitMs) {
    const deployment = await getLatestRailwayDeployment(serviceId, environmentId);

    if (!deployment) {
      log('Waiting for deployment to start...');
      await sleep(pollIntervalMs);
      continue;
    }

    deploymentId = deployment.id;

    if (deployment.status !== lastStatus) {
      log(`Deployment status: ${deployment.status}`);
      lastStatus = deployment.status;
    }

    // Terminal states
    if (deployment.status === 'SUCCESS') {
      log('Deployment succeeded!');
      return {
        success: true,
        status: 'SUCCESS',
        url: deployment.url ? `https://${deployment.url}` : undefined,
      };
    }

    if (['FAILED', 'CRASHED', 'REMOVED'].includes(deployment.status)) {
      log(`Deployment failed with status: ${deployment.status}`);

      // Fetch build logs for failed deployments
      const buildLogs = await getRailwayBuildLogs(deploymentId);

      return {
        success: false,
        status: deployment.status,
        buildLogs: buildLogs || `Deployment ${deployment.status.toLowerCase()} - no logs available`,
      };
    }

    await sleep(pollIntervalMs);
  }

  // Timeout - try to get whatever logs we have
  log('Deployment timed out');
  const buildLogs = deploymentId ? await getRailwayBuildLogs(deploymentId) : null;

  return {
    success: false,
    status: 'TIMEOUT',
    buildLogs: buildLogs || 'Deployment timed out waiting for completion',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
