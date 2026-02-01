# ClawRunner Security Audit Report

**Date:** 2026-02-01
**Auditor:** SecurityOversight Agent
**Scope:** clawrunner/src/ (3 files)

## Executive Summary

Audited the ClawRunner API server codebase for security vulnerabilities. Found **1 CRITICAL** issue (fixed), **2 MEDIUM** issues, and **2 LOW** issues.

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| src/index.ts | 38 | Express server setup |
| src/api/nango-auth.ts | 176 | OAuth authentication routes |
| src/services/nango.ts | 160 | Nango API integration service |

---

## Critical Issues

### 1. [FIXED] Webhook Signature Bypass (nango-auth.ts:94-101)

**Severity:** CRITICAL
**Status:** FIXED

**Description:** The webhook endpoint only verified signatures when a signature header was present. Attackers could forge webhook requests by simply omitting the signature header.

**Original Code:**
```typescript
const hasSignature = req.headers['x-nango-signature'] || req.headers['x-nango-hmac-sha256'];
if (hasSignature) {
  if (!nangoService.verifyWebhookSignature(...)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
}
// Processed unsigned webhooks!
```

**Fix Applied:** Signature verification is now mandatory. Unsigned requests are rejected with 401.

**Impact:** Prevented attackers from forging auth webhooks to inject fake user sessions.

---

## Medium Issues

### 2. Connection ID Enumeration (nango-auth.ts:54-82)

**Severity:** MEDIUM
**Status:** Open

**Description:** The `/login-status/:connectionId` endpoint allows anyone to poll any connection ID without authentication. An attacker could:
- Enumerate valid connection IDs via timing attacks
- Potentially intercept login sessions if they guess a valid connectionId before the legitimate user polls

**Location:** `nango-auth.ts:54-82`

**Recommendation:**
1. Bind connectionId to client session/IP at creation time
2. Use cryptographically random, high-entropy connection IDs
3. Implement rate limiting on this endpoint
4. Consider short-lived polling tokens

---

### 3. No Rate Limiting (all endpoints)

**Severity:** MEDIUM
**Status:** Open

**Description:** No rate limiting on any endpoints. Attackers could:
- Flood `/login-session` to exhaust Nango API quotas
- Brute-force `/login-status/:connectionId` to find valid sessions
- DoS the webhook endpoint

**Recommendation:** Implement rate limiting using express-rate-limit:
```typescript
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: { error: 'Too many login attempts' }
});

app.use('/api/auth/nango/login-session', loginLimiter);
```

---

## Low Issues

### 4. In-Memory Session Storage (nango-auth.ts:15-22)

**Severity:** LOW
**Status:** Acknowledged (dev mode)

**Description:** `pendingLogins` uses in-memory Map storage. Sessions are lost on server restart and don't work in multi-instance deployments.

**Note:** Code comments acknowledge this is intended for development only.

**Recommendation:** Use Redis or database for production:
```typescript
// Production: Use Redis
const redis = new Redis(process.env.REDIS_URL);
await redis.setex(`login:${connectionId}`, 600, JSON.stringify(loginData));
```

---

### 5. Missing Input Validation on connectionId

**Severity:** LOW
**Status:** Open

**Description:** The `connectionId` parameter from URL is used directly without format validation.

**Location:** `nango-auth.ts:55`

**Recommendation:** Validate connectionId format:
```typescript
const connectionIdRegex = /^[a-zA-Z0-9-_]{1,128}$/;
if (!connectionIdRegex.test(connectionId)) {
  return res.status(400).json({ error: 'Invalid connection ID' });
}
```

---

## Positive Findings

### Secrets Management: PASS
- No hardcoded secrets in codebase
- `NANGO_SECRET_KEY` correctly loaded from environment variables
- Secret key validation with helpful error messages

### Error Handling: PASS
- Errors logged server-side with details
- Generic error messages returned to clients (no info leakage)
- Proper try/catch blocks around async operations

### Database Security: N/A
- No direct database queries in this codebase
- Uses Nango API as data layer

### Webhook Security: PASS (after fix)
- Raw body captured for signature verification
- HMAC-SHA256 signature verification implemented
- Fallback verification logic in place

---

## Recommendations Summary

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Webhook signature bypass | Done | Critical |
| P1 | Add rate limiting | Medium | High |
| P1 | ConnectionId session binding | Medium | High |
| P2 | Migrate to persistent sessions | High | Medium |
| P2 | Input validation on connectionId | Low | Low |

---

## Out of Scope

The following security areas were not applicable to this audit:

- **Open Claw Security:** No Open Claw code in clawrunner/src/
- **Authorization/RBAC:** No multi-tenant authorization logic present
- **SQL Injection:** No direct database queries
- **CSRF:** API appears to be stateless/token-based

---

## Conclusion

The ClawRunner authentication code has a solid foundation with proper secrets management and error handling. The critical webhook bypass vulnerability has been fixed. Medium-priority issues around rate limiting and session security should be addressed before production deployment.
