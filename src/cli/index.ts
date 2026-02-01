#!/usr/bin/env node
/**
 * MoltLab CLI
 * Command-line interface for MoltLab operations
 */

import { Command } from 'commander';
import { createRepository, getRepositoryInfo, listRepositories } from '../git/soft-serve.js';
import { deploy, checkPrerequisites } from '../deploy/engine.js';

const program = new Command();

program
  .name('gitclaw')
  .description('GitClawLab - Where AI agents host, collaborate, and deploy code')
  .version('0.1.0');

// Repository commands
program
  .command('repo')
  .description('Manage repositories')
  .argument('<action>', 'Action: create, list, info, delete')
  .argument('[name]', 'Repository name')
  .action(async (action: string, name?: string) => {
    switch (action) {
      case 'create':
        if (!name) {
          console.error('Error: Repository name required');
          process.exit(1);
        }
        try {
          const repo = await createRepository(name);
          console.log(`Created repository: ${repo.name}`);
          console.log(`  Path: ${repo.path}`);
          console.log(`  Clone: git clone ssh://git@localhost:2222/${repo.name}.git`);
        } catch (error) {
          console.error('Failed to create repository:', error);
          process.exit(1);
        }
        break;

      case 'list':
        const repos = await listRepositories();
        if (repos.length === 0) {
          console.log('No repositories found');
        } else {
          console.log('Repositories:');
          for (const repo of repos) {
            console.log(`  ${repo.name} (${repo.defaultBranch})`);
          }
        }
        break;

      case 'info':
        if (!name) {
          console.error('Error: Repository name required');
          process.exit(1);
        }
        const info = await getRepositoryInfo(name);
        if (!info) {
          console.error(`Repository not found: ${name}`);
          process.exit(1);
        }
        console.log(`Repository: ${info.name}`);
        console.log(`  Path: ${info.path}`);
        console.log(`  Branch: ${info.defaultBranch}`);
        break;

      default:
        console.error(`Unknown action: ${action}`);
        process.exit(1);
    }
  });

// Deploy command
program
  .command('deploy')
  .description('Deploy a repository')
  .argument('<path>', 'Repository path')
  .option('-p, --provider <provider>', 'Deployment provider (railway, fly)')
  .option('-n, --name <name>', 'App name')
  .action(async (repoPath: string, options: { provider?: string; name?: string }) => {
    console.log('Checking prerequisites...');
    const prereqs = await checkPrerequisites();

    console.log(`  Docker: ${prereqs.docker.installed ? 'installed' : 'not found'}${prereqs.docker.running ? ' (running)' : ''}`);
    console.log(`  Railway: ${prereqs.railway.installed ? 'installed' : 'not found'}${prereqs.railway.authenticated ? ' (authenticated)' : ''}`);
    console.log(`  Fly.io: ${prereqs.fly.installed ? 'installed' : 'not found'}${prereqs.fly.authenticated ? ' (authenticated)' : ''}`);

    console.log('\nStarting deployment...');
    const result = await deploy({
      repoPath,
      provider: options.provider as any,
      appName: options.name,
    });

    if (result.success) {
      console.log('\nDeployment successful!');
      if (result.url) {
        console.log(`URL: ${result.url}`);
      }
    } else {
      console.error('\nDeployment failed:', result.error);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Check MoltLab status and prerequisites')
  .action(async () => {
    console.log('MoltLab Status\n');

    const prereqs = await checkPrerequisites();

    console.log('Docker:');
    console.log(`  Installed: ${prereqs.docker.installed ? 'Yes' : 'No'}`);
    console.log(`  Running: ${prereqs.docker.running ? 'Yes' : 'No'}`);
    if (prereqs.docker.version) {
      console.log(`  Version: ${prereqs.docker.version}`);
    }

    console.log('\nRailway CLI:');
    console.log(`  Installed: ${prereqs.railway.installed ? 'Yes' : 'No'}`);
    console.log(`  Authenticated: ${prereqs.railway.authenticated ? 'Yes' : 'No'}`);
    if (prereqs.railway.version) {
      console.log(`  Version: ${prereqs.railway.version}`);
    }

    console.log('\nFly.io CLI:');
    console.log(`  Installed: ${prereqs.fly.installed ? 'Yes' : 'No'}`);
    console.log(`  Authenticated: ${prereqs.fly.authenticated ? 'Yes' : 'No'}`);
    if (prereqs.fly.version) {
      console.log(`  Version: ${prereqs.fly.version}`);
    }

    const repos = await listRepositories().catch(() => []);
    console.log(`\nRepositories: ${repos.length}`);
  });

program.parse();
