/**
 * Docker Build Helper
 * Handles Docker image building for deployments
 */

import { execa } from 'execa';
import { existsSync } from 'fs';
import { join } from 'path';
import type { BuildResult } from './types.js';

export interface DockerBuildOptions {
  repoPath: string;
  imageName: string;
  tag?: string;
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  platform?: string;
}

/**
 * Check if Docker is installed and running
 */
export async function checkDocker(): Promise<{ installed: boolean; running: boolean; version?: string }> {
  try {
    const { stdout } = await execa('docker', ['--version']);
    const version = stdout.match(/Docker version ([\d.]+)/)?.[1];

    // Check if daemon is running
    try {
      await execa('docker', ['info'], { timeout: 5000 });
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  } catch {
    return { installed: false, running: false };
  }
}

/**
 * Check if Dockerfile exists in repo
 */
export function hasDockerfile(repoPath: string, dockerfile = 'Dockerfile'): boolean {
  return existsSync(join(repoPath, dockerfile));
}

/**
 * Build a Docker image from the repo
 */
export async function buildImage(options: DockerBuildOptions): Promise<BuildResult> {
  const {
    repoPath,
    imageName,
    tag = 'latest',
    dockerfile = 'Dockerfile',
    buildArgs = {},
    platform,
  } = options;

  const logs: string[] = [];
  const imageTag = `${imageName}:${tag}`;

  // Verify Dockerfile exists
  if (!hasDockerfile(repoPath, dockerfile)) {
    return {
      success: false,
      error: `Dockerfile not found at ${join(repoPath, dockerfile)}`,
      logs: ['ERROR: Dockerfile not found'],
    };
  }

  // Build command args
  const args = ['build', '-t', imageTag, '-f', dockerfile];

  // Add platform if specified
  if (platform) {
    args.push('--platform', platform);
  }

  // Add build args
  for (const [key, value] of Object.entries(buildArgs)) {
    args.push('--build-arg', `${key}=${value}`);
  }

  // Add context path
  args.push('.');

  logs.push(`Building image: ${imageTag}`);
  logs.push(`Command: docker ${args.join(' ')}`);

  try {
    const process = execa('docker', args, {
      cwd: repoPath,
      timeout: 600000, // 10 minute timeout
    });

    // Stream output
    process.stdout?.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    process.stderr?.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    await process;

    logs.push(`Successfully built ${imageTag}`);

    return {
      success: true,
      imageTag,
      logs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logs.push(`ERROR: Build failed - ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
      logs,
    };
  }
}

/**
 * Tag an image for a remote registry
 */
export async function tagImage(
  localTag: string,
  remoteTag: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await execa('docker', ['tag', localTag, remoteTag]);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Push an image to a registry
 */
export async function pushImage(imageTag: string): Promise<{ success: boolean; error?: string; logs: string[] }> {
  const logs: string[] = [];
  logs.push(`Pushing image: ${imageTag}`);

  try {
    const process = execa('docker', ['push', imageTag], {
      timeout: 300000, // 5 minute timeout
    });

    process.stdout?.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    process.stderr?.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    await process;
    logs.push(`Successfully pushed ${imageTag}`);

    return { success: true, logs };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logs.push(`ERROR: Push failed - ${errorMessage}`);
    return { success: false, error: errorMessage, logs };
  }
}

/**
 * Remove a local image
 */
export async function removeImage(imageTag: string): Promise<void> {
  try {
    await execa('docker', ['rmi', imageTag]);
  } catch {
    // Ignore errors when removing images
  }
}

/**
 * Generate a default Dockerfile for Node.js projects
 */
export function generateNodeDockerfile(port = 3000): string {
  return `FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build 2>/dev/null || true

EXPOSE ${port}

CMD ["node", "dist/index.js"]
`;
}
