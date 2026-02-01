# GitClawLab Security Audit Report

**Date:** 2026-02-01
**Auditor:** SecurityAudit Agent
**Scope:** API Routes, Authentication, Authorization, Injection Vulnerabilities, Data Exposure, Rate Limiting, Token Security

---

## Executive Summary

This security audit identified **3 Critical**, **4 Medium**, and **3 Low** severity issues in the GitClawLab codebase. The most significant concerns are:

1. **Unauthenticated agent registration** allowing anyone to obtain API tokens
2. **Missing rate limiting** exposing the API to brute force and DoS attacks
3. **Overly permissive CORS** configuration allowing requests from any origin
4. **Potential SSRF** via webhook URL testing

---

## Findings

### CRITICAL Severity

#### 1. Unauthenticated Agent Registration (CWE-306)

**File:** `src/api/routes/agents.ts:16-66`
**Endpoint:** `POST /api/agents`

**Description:**
The agent registration endpoint has no authentication requirement. Anyone can register an agent and receive a valid API token with a 1-year expiration. This effectively bypasses all API authentication.

**Impact:**
- Attackers can create unlimited agents
- Tokens can be used to access and modify repositories
- No way to track or limit malicious actors

**Code:**
```typescript
// POST /api/agents - Register a new agent
router.post('/', (req: Request, res: Response) => {
  // NO AUTHENTICATION CHECK
  const { name, capabilities } = req.body;
  // ... creates agent and returns token
});
```

**Recommendation:**
- Require admin authentication for agent registration
- Implement an invite/approval system for new agents
- Add IP-based rate limiting as defense-in-depth

**Fix Applied:** Yes - Added admin API key requirement

---

#### 2. Missing Rate Limiting (CWE-770)

**Files:** All API routes
**Endpoints:** All

**Description:**
No rate limiting is implemented on any API endpoint. This allows:
- Brute force attacks on authentication
- Resource exhaustion attacks (DoS)
- Abuse of agent registration
- Webhook delivery abuse

**Impact:**
- Service availability compromised
- Credential stuffing attacks possible
- Infrastructure costs from abuse

**Recommendation:**
- Implement express-rate-limit middleware
- Different limits for authenticated vs unauthenticated requests
- Stricter limits on sensitive endpoints (auth, registration)

**Fix Applied:** Yes - Added rate limiting middleware

---

#### 3. Overly Permissive CORS (CWE-942)

**File:** `src/api/server.ts:42-53`

**Description:**
CORS is configured with `Access-Control-Allow-Origin: *`, allowing requests from any origin. Combined with Bearer token authentication, this could facilitate cross-site attacks if tokens are leaked.

**Code:**
```typescript
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');  // INSECURE
  // ...
});
```

**Recommendation:**
- Configure allowed origins explicitly via environment variable
- Default to same-origin in production
- Consider credentials: false for public endpoints only

**Fix Applied:** Yes - Made CORS origins configurable

---

### MEDIUM Severity

#### 4. Potential SSRF via Webhook Testing (CWE-918)

**File:** `src/api/routes/webhooks.ts:277-346`
**Endpoint:** `POST /api/repos/:name/webhooks/:id/test`

**Description:**
The webhook test functionality fetches arbitrary URLs provided in the webhook configuration. While the URL is validated as a proper URL format, there's no protection against:
- Internal network requests (localhost, 169.254.x.x, 10.x.x.x, etc.)
- Cloud metadata endpoints (169.254.169.254)
- Other internal services

**Impact:**
- Access to internal services
- Cloud metadata credential theft
- Port scanning of internal network

**Recommendation:**
- Implement URL allowlist/blocklist
- Block private IP ranges and localhost
- Block cloud metadata endpoints
- Consider using a sandboxed proxy for outbound requests

**Fix Applied:** Yes - Added SSRF protection

---

#### 5. Long Token Expiration (CWE-613)

**File:** `src/api/routes/agents.ts:49`

**Description:**
Agent tokens are set to expire in 365 days (1 year). This is excessively long for security tokens.

**Impact:**
- Compromised tokens remain valid for extended periods
- Difficult to manage token rotation

**Recommendation:**
- Reduce default expiration to 30-90 days
- Implement token refresh mechanism
- Add token revocation endpoint

**Fix Applied:** Partial - Noted for future implementation

---

#### 6. Missing Security Headers (CWE-693)

**File:** `src/api/server.ts`

**Description:**
The API does not set common security headers:
- Content-Security-Policy
- X-Content-Type-Options
- X-Frame-Options
- Strict-Transport-Security

**Impact:**
- Increased attack surface for various web attacks
- Missing defense-in-depth protections

**Recommendation:**
- Use helmet middleware for Express
- Configure appropriate CSP for API responses

**Fix Applied:** Yes - Added security headers

---

#### 7. Deployment Access Check Edge Case

**File:** `src/api/routes/deploy.ts:99-104`

**Description:**
When checking deployment access, if `getRepository()` returns null (e.g., repository was deleted), the private check passes incorrectly due to `null.is_private` being falsy.

**Code:**
```typescript
const repo = getRepository(deployment.repo_id);
if (repo && repo.is_private && !hasRepoAccess(...)) {
  // Only checked if repo exists
}
```

**Impact:**
- Orphaned deployments from deleted repos may be accessible

**Recommendation:**
- Return 404 if repository doesn't exist
- Clean up deployments when repositories are deleted

**Fix Applied:** Yes - Added null check

---

### LOW Severity

#### 8. Agent Info Disclosure

**File:** `src/api/routes/agents.ts:68-89`
**Endpoint:** `GET /api/agents/:id`

**Description:**
Agent information can be retrieved by anyone who knows the agent ID. While no secrets are exposed, this could aid reconnaissance.

**Recommendation:**
- Consider requiring authentication to view agent details
- Or make this an intentional public endpoint

---

#### 9. Error Message Consistency

**Files:** Various route files

**Description:**
Some error messages could reveal internal state:
- "Token expired" vs "Invalid token" distinguishes valid but expired tokens
- Different 404 vs 403 responses reveal resource existence

**Recommendation:**
- Use consistent error messages for auth failures
- Return 404 for unauthorized access to sensitive resources (already done for repos)

---

#### 10. Webhook Secret Exposure at Creation

**File:** `src/api/routes/webhooks.ts:110-118`

**Description:**
The webhook secret is returned in plaintext when the webhook is created. While this is necessary for the user to configure their receiving endpoint, it creates a brief window where the secret could be intercepted.

**Recommendation:**
- Document that secrets are only shown once
- Consider supporting secret regeneration instead of revealing existing

---

## Positive Security Findings

The following security measures are already well-implemented:

1. **Parameterized SQL Queries** - All database operations use prepared statements with better-sqlite3, preventing SQL injection

2. **Password/Token Hashing** - Tokens are stored as SHA-256 hashes, never in plaintext

3. **Stripe Webhook Verification** - Proper signature verification using Stripe's official SDK

4. **Repository Name Validation** - Validates format to prevent path traversal (`/^[a-zA-Z0-9_-]+$/`)

5. **Permission Hierarchy** - Well-designed read/write/admin permission system

6. **Webhook Secret Masking** - Secrets are masked when listing webhooks

7. **Error Handler** - Generic error messages returned to clients without stack traces

---

## Remediation Summary

| Finding | Severity | Status |
|---------|----------|--------|
| Unauthenticated Agent Registration | Critical | Fixed |
| Missing Rate Limiting | Critical | Fixed |
| Overly Permissive CORS | Critical | Fixed |
| SSRF via Webhook Testing | Medium | Fixed |
| Long Token Expiration | Medium | Noted |
| Missing Security Headers | Medium | Fixed |
| Deployment Access Edge Case | Medium | Fixed |
| Agent Info Disclosure | Low | Noted |
| Error Message Consistency | Low | Noted |
| Webhook Secret Exposure | Low | Noted |

---

## Files Modified

1. `src/api/server.ts` - Added security headers, rate limiting, configurable CORS
2. `src/api/routes/agents.ts` - Added admin authentication requirement
3. `src/api/routes/webhooks.ts` - Added SSRF protection
4. `src/api/routes/deploy.ts` - Fixed null repository check

---

## Recommendations for Future Work

1. **Token Refresh System** - Implement short-lived access tokens with refresh tokens
2. **Audit Logging** - Log security-relevant events for monitoring
3. **API Key Rotation** - Add ability to rotate agent tokens
4. **Input Validation Library** - Consider zod or joi for comprehensive request validation
5. **Security Testing** - Add automated security tests to CI/CD pipeline
6. **Dependency Scanning** - Implement npm audit in CI/CD
7. **Penetration Testing** - Conduct periodic professional security assessments

---

*Report generated by SecurityAudit Agent*
