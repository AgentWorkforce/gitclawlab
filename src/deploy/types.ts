/**
 * Deploy Engine Types
 */

export type DeployProvider = 'railway' | 'fly';

export type DeployStatus = 'pending' | 'building' | 'deploying' | 'success' | 'failed';

export interface MoltlabConfig {
  name: string;
  deploy?: {
    provider?: DeployProvider;
    /**
     * Legacy key supported in examples; mapped to provider internally.
     */
    target?: DeployProvider | 'coolify';
    region?: string;
    env?: Record<string, string>;
    port?: number;
    healthcheck?: string;
    customDomain?: string;
    subdomain?: string;
  };
}

export interface DeployOptions {
  repoPath: string;
  commitSha: string;
  provider: DeployProvider;
  appName: string;
  config?: MoltlabConfig;
  env?: Record<string, string>;
  customDomain?: string;
}

export interface DeployResult {
  success: boolean;
  url?: string;
  customDomain?: string;
  error?: string;
  logs: string[];
}

export interface BuildResult {
  success: boolean;
  imageTag?: string;
  error?: string;
  logs: string[];
}

export interface ProviderStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
}

export type DeployProviderName = DeployProvider;
