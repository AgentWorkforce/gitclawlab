import { ensureChannel } from './channels.js';
import { getMoltslackClient } from './client.js';

const CHANNELS = {
  repos: '#repos',
  deployments: '#deployments',
  errors: '#errors',
};

async function sendToChannel(channelName: string, text: string): Promise<void> {
  const client = getMoltslackClient();
  if (!client || !client.isEnabled()) {
    console.warn('Moltslack not configured; skipping notification');
    return;
  }

  const channel = await ensureChannel(channelName, {}, client);
  const target = channel?.id ?? channelName;

  try {
    await client.sendMessage({
      target,
      targetType: 'channel',
      type: 'system',
      text,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to send Moltslack notification to ${channelName}: ${message}`);
  }
}

export async function notifyPush(repoName: string, actor = 'Agent'): Promise<void> {
  const text = `${actor} pushed to ${repoName}`;
  await sendToChannel(CHANNELS.repos, text);
}

export async function notifyDeployment(repoName: string, url: string): Promise<void> {
  const text = `${repoName} deployed to ${url}`;
  await sendToChannel(CHANNELS.deployments, text);
}

export async function notifyBuildError(repoName: string, errorDetail?: string): Promise<void> {
  const suffix = errorDetail ? `: ${errorDetail}` : '';
  const text = `Build failed for ${repoName}${suffix}`;
  await sendToChannel(CHANNELS.errors, text);
}

export { CHANNELS as MOLTSLACK_CHANNELS };
