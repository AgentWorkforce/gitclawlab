/**
 * MoltLab Deploy Module
 * Re-exports all deploy functionality
 */

export {
  deploy,
  quickDeploy,
  parseConfig,
  checkPrerequisites,
  type DeployEngineOptions,
  type DeployEngineResult,
} from './engine.js';

export {
  checkDocker,
  hasDockerfile,
  buildImage,
  tagImage,
  pushImage,
  removeImage,
  generateNodeDockerfile,
  type DockerBuildOptions,
} from './docker.js';

export {
  checkRailwayStatus,
  deployToRailway,
  getRailwayUrl,
  deleteRailwayProject,
  addCustomDomain,
  generateSubdomain,
  GITCLAWLAB_BASE_DOMAIN,
} from './providers/railway.js';

export {
  checkFlyStatus,
  deployToFly,
  getFlyAppStatus,
  deleteFlyApp,
  scaleFlyApp,
} from './providers/fly.js';

export type {
  DeployProvider,
  DeployStatus,
  DeployOptions,
  DeployResult,
  BuildResult,
  MoltlabConfig,
  ProviderStatus,
} from './types.js';
