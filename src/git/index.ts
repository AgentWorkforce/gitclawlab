/**
 * Git Module
 * Git server hosting via soft-serve with SSH key management and hooks
 */

// Re-export soft-serve server functions
export {
  initGitServer,
  stopGitServer,
  createBareRepository,
  createRepository,
  listRepositories,
  getRepositoryInfo,
  ensureAgentKey,
  getRepositoriesPath,
  type GitServerOptions,
  type RepositoryInfo,
} from './soft-serve.js';

// Re-export permissions/SSH key management
export {
  listAgentKeys,
  addAgentKey,
  removeAgentKey,
  writeAuthorizedKeys,
  getAuthorizedKeysPath,
  getAdminKeyEnv,
  getDataRoot,
  type AccessLevel,
  type AgentKey,
} from './permissions.js';

// Re-export git hook handlers
export {
  installPostReceiveHook,
  handlePostReceive,
  readUpdatesFromStdin,
  type ReceiveUpdate,
} from './hooks.js';
