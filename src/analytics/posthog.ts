/**
 * PostHog Analytics - Server-side tracking module
 */

import { PostHog } from 'posthog-node';

const POSTHOG_KEY = 'phc_cdodRi3aNQiLNg0co7YbB1jVAYILFZZ6O26pmkfLa8Y';
const isDev = process.env.NODE_ENV === 'development';

// Disabled in dev mode
const client = !isDev
  ? new PostHog(POSTHOG_KEY, { host: 'https://us.i.posthog.com' })
  : null;

export function track(distinctId: string, event: string, properties?: Record<string, unknown>) {
  client?.capture({ distinctId, event, properties });
}

export function identify(distinctId: string, properties: Record<string, unknown>) {
  client?.identify({ distinctId, properties });
}

export async function shutdown() {
  await client?.shutdown();
}
