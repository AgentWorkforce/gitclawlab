/**
 * GitClawLab Subdomain Router
 *
 * Routes *.gitclawlab.com requests to the correct Railway deployment.
 * Uses KV for caching deployment URLs to minimize API calls.
 */

export interface Env {
  // KV namespace for caching subdomain -> Railway URL mappings
  DEPLOYMENTS: KVNamespace;
  // GitClawLab API base URL
  GITCLAWLAB_API: string;
}

// Cache TTL in seconds (60 seconds - fast updates on redeploy)
const CACHE_TTL = 60;

// Subdomains that should pass through to the main GitClawLab server
const PASSTHROUGH_SUBDOMAINS = ['www', 'api', 'git', 'ssh'];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Extract subdomain from hostname (e.g., "prpm-advertisement" from "prpm-advertisement.gitclawlab.com")
    const parts = hostname.split('.');

    // Handle apex domain or passthrough subdomains
    if (parts.length < 3 || PASSTHROUGH_SUBDOMAINS.includes(parts[0])) {
      // Pass through to origin (main GitClawLab server)
      return fetch(request);
    }

    const subdomain = parts[0];

    // Try to get cached Railway URL
    let railwayUrl = await env.DEPLOYMENTS.get(subdomain);

    if (!railwayUrl) {
      // Cache miss - fetch from GitClawLab API
      const lookupResult = await lookupDeploymentUrl(subdomain, env);

      if (!lookupResult.success) {
        return new Response(lookupResult.error || 'App not found', {
          status: lookupResult.status || 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      railwayUrl = lookupResult.url!;

      // Cache the URL (fire and forget)
      ctx.waitUntil(
        env.DEPLOYMENTS.put(subdomain, railwayUrl, { expirationTtl: CACHE_TTL })
      );
    }

    // Proxy the request to Railway
    return proxyToRailway(request, url, railwayUrl);
  },
};

interface LookupResult {
  success: boolean;
  url?: string;
  error?: string;
  status?: number;
}

async function lookupDeploymentUrl(subdomain: string, env: Env): Promise<LookupResult> {
  const apiBase = env.GITCLAWLAB_API || 'https://www.gitclawlab.com';

  try {
    // Use the dedicated lookup endpoint for efficiency
    const response = await fetch(`${apiBase}/api/lookup/${subdomain}`, {
      headers: {
        'User-Agent': 'GitClawLab-Worker/1.0',
      },
    });

    if (response.status === 404) {
      return { success: false, error: 'App not found', status: 404 };
    }

    if (!response.ok) {
      return { success: false, error: 'Lookup failed', status: 502 };
    }

    const data = await response.json() as { url?: string; error?: string };

    if (!data.url) {
      return { success: false, error: data.error || 'No deployment URL available', status: 503 };
    }

    return { success: true, url: data.url };
  } catch (error) {
    console.error('Lookup error:', error);
    return { success: false, error: 'Service unavailable', status: 503 };
  }
}

async function proxyToRailway(
  originalRequest: Request,
  originalUrl: URL,
  railwayUrl: string
): Promise<Response> {
  // Build the target URL
  const target = new URL(originalUrl.pathname + originalUrl.search, railwayUrl);

  // Create new headers, preserving most from original request
  const headers = new Headers(originalRequest.headers);

  // Update host header for Railway
  headers.set('Host', new URL(railwayUrl).host);

  // Add forwarded headers for debugging
  headers.set('X-Forwarded-Host', originalUrl.hostname);
  headers.set('X-Forwarded-Proto', 'https');

  // Remove Cloudflare-specific headers that might cause issues
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');

  try {
    const response = await fetch(target.toString(), {
      method: originalRequest.method,
      headers,
      body: originalRequest.body,
      redirect: 'follow',
    });

    // Return response with CORS headers if needed
    const responseHeaders = new Headers(response.headers);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response('Bad Gateway', { status: 502 });
  }
}
