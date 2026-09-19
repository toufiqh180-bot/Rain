# Rain: Production Deployment Guide

This document covers everything needed to safely deploy Rain as a competitor to Omegle/Emerald while avoiding the catastrophic failures that caused Omegle to shut down in 2023.

## Critical Safety Lessons from Omegle's Failure

- **Omegle shutdown in 2023** due to child sexual exploitation lawsuits ($22M settlement)
- **Lack of age verification** despite warning splash screens
- **No moderation infrastructure** for reports and abuse prevention
- **Minimal device/network reputation** tracking
- **No automated abuse detection** or escalation
- **Persistent transcripts** of conversations (bad for privacy and liability)

Rain avoids these by design:
- **Temporary, ephemeral conversations** — no message persistence by default
- **Strong age gating** with verification (CAPTCHA, device reputation)
- **Per-user rate limiting** and abuse escalation
- **Real-time moderation tooling** with report triage queues
- **Device fingerprinting** to detect patterns of abuse
- **Guest accounts auto-delete** on logout
- **Automated escalation** (warn → mute → suspend → ban)

---

## Pre-Launch Checklist

### Legal & Compliance (REQUIRED)
- [ ] **Terms of Service** reviewed by counsel. Cover:
  - 18+ only policy (enforce strictly)
  - No CSAM, harassment, hate speech
  - Auto-deletion of guest accounts
  - Data retention policy (90-day anonymization for most logs)
  - GDPR/CCPA compliance for user deletion
  - Copyright/DMCA procedures
- [ ] **Privacy Policy** clearly states:
  - What is stored (minimal; no message transcripts)
  - How long data is retained
  - User's right to delete their account
  - Third-party services (Stripe, LiveKit, hCaptcha)
- [ ] **Age Verification Policy** documented
  - CAPTCHA on signup and guest join
  - Device fingerprinting to prevent child accounts
  - Manual review process for flagged reports
- [ ] **Abuse Report & Appeal Process**
  - Clear reasoning for any bans
  - Appeal mechanism with human review
  - SLA for response (e.g., 48 hours)
- [ ] **Content Moderation Policy**
  - Report categories (harassment, sexual-content, hate, minor-safety, spam, other)
  - Escalation rules (3 warnings → mute, mute + violation → suspend)
  - Ban appeal process
- [ ] **Insurance** (content liability, data breach, abuse)

### Technical Setup

#### Database
```bash
# Run migrations in order
psql $DATABASE_URL < apps/api/migrations/001_init.sql
psql $DATABASE_URL < apps/api/migrations/002_guest_circles_age.sql
psql $DATABASE_URL < apps/api/migrations/003_safety_enhancements.sql

# Verify tables
psql $DATABASE_URL -c "\dt"
```

#### Environment Variables (Production)
```bash
# API
NODE_ENV=production
PORT=4000
HOST=0.0.0.0
DATABASE_URL=postgres://user:pass@host:5432/rain
DATABASE_POOL_MAX=20
DATABASE_SSL=require
REDIS_URL=redis://host:6379
INTERNAL_API_KEY=$(openssl rand -hex 24)

# CORS & Cookies
ALLOWED_ORIGINS=https://rain.yoursite.com,https://www.rain.yoursite.com
COOKIE_DOMAIN=.rain.yoursite.com
SESSION_TTL_HOURS=720  # 30 days

# Safety & Abuse Prevention
REQUIRE_CAPTCHA_ON_SIGNUP=true
HCAPTCHA_SECRET=<from hCaptcha dashboard>
HCAPTCHA_SITE_KEY=<from hCaptcha dashboard>
DEVICE_REPUTATION_ENABLED=true
MAX_MATCHES_PER_HOUR=30
MAX_MESSAGES_PER_MINUTE=20
MAX_CONNECTIONS_PER_DAY=50

# Storage (Avatar uploads)
STORAGE_DRIVER=s3
S3_BUCKET=rain-avatars-prod
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_ACCESS_KEY_ID=<AWS IAM user>
S3_SECRET_ACCESS_KEY=<AWS IAM secret>
STORAGE_PUBLIC_URL=https://avatars.rain.yoursite.com

# Billing (Stripe)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PLUS=price_...
STRIPE_PRICE_PRO=price_...
BILLING_RETURN_URL=https://rain.yoursite.com/membership

# Email
EMAIL_FROM=noreply@rain.yoursite.com
RESEND_API_KEY=<from Resend>

# Voice/Video
LIVEKIT_URL=https://livekit.yoursite.com
LIVEKIT_API_KEY=<from LiveKit>
LIVEKIT_API_SECRET=<from LiveKit>
PUBLIC_API_URL=https://api.rain.yoursite.com
```

#### TLS & Security Headers (nginx example)
```nginx
server {
  listen 443 ssl http2;
  server_name rain.yoursite.com;

  ssl_certificate /etc/letsencrypt/live/rain.yoursite.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/rain.yoursite.com/privkey.pem;
  ssl_protocols TLSv1.3 TLSv1.2;
  ssl_ciphers HIGH:!aNULL:!MD5;
  ssl_prefer_server_ciphers on;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 10m;

  # Security headers
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header X-XSS-Protection "1; mode=block" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "microphone=(), camera=(), geolocation=()" always;

  # Content Security Policy (strict)
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; font-src 'self'; connect-src 'self' https://hcaptcha.com https://*.hcaptcha.com; frame-src https://hcaptcha.com https://*.hcaptcha.com" always;

  location / {
    proxy_pass http://localhost:5173;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/ {
    proxy_pass http://localhost:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

# Redirect HTTP to HTTPS
server {
  listen 80;
  server_name rain.yoursite.com www.rain.yoursite.com;
  return 301 https://$server_name$request_uri;
}
```

#### Docker Compose for Production
```yaml
version: '3.9'

services:
  # PostgreSQL database
  db:
    image: postgres:15-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: rain
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
      POSTGRES_DB: rain
    ports:
      - "127.0.0.1:5432:5432"
    restart: always

  # Redis for queues and realtime
  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6379:6379"
    restart: always

  # Rain API
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      NODE_ENV: production
      PORT: 4000
      DATABASE_URL: postgres://rain:${DATABASE_PASSWORD}@db:5432/rain
      DATABASE_SSL: disable  # Internal network
      REDIS_URL: redis://redis:6379
      INTERNAL_API_KEY: ${INTERNAL_API_KEY}
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}
      COOKIE_DOMAIN: ${COOKIE_DOMAIN}
      HCAPTCHA_SECRET: ${HCAPTCHA_SECRET}
      HCAPTCHA_SITE_KEY: ${HCAPTCHA_SITE_KEY}
      REQUIRE_CAPTCHA_ON_SIGNUP: "true"
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET}
      STRIPE_PRICE_PLUS: ${STRIPE_PRICE_PLUS}
      STRIPE_PRICE_PRO: ${STRIPE_PRICE_PRO}
      EMAIL_FROM: ${EMAIL_FROM}
      RESEND_API_KEY: ${RESEND_API_KEY}
      LIVEKIT_URL: ${LIVEKIT_URL}
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      S3_BUCKET: ${S3_BUCKET}
      S3_REGION: ${S3_REGION}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      STORAGE_DRIVER: s3
      PUBLIC_API_URL: ${PUBLIC_API_URL}
    depends_on:
      - db
      - redis
    ports:
      - "127.0.0.1:4000:4000"
    restart: always
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Rain Realtime Gateway
  realtime:
    build:
      context: .
      dockerfile: apps/realtime/Dockerfile
    environment:
      NODE_ENV: production
      PORT: 3000
      MATCHMAKER_DRIVER: redis
      REDIS_URL: redis://redis:6379
      AUTH_INTROSPECTION_URL: http://api:4000/v1/internal/realtime/introspect
      AUTH_INTROSPECTION_KEY: ${INTERNAL_API_KEY}
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}
    depends_on:
      - redis
      - api
    ports:
      - "127.0.0.1:3000:3000"
    restart: always
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  pgdata:
```

---

## Monitoring & Observability

### Health Checks
```bash
# API health
curl https://api.rain.yoursite.com/healthz

# Realtime gateway health
curl https://realtime.rain.yoursite.com/healthz

# Readiness (no traffic until this passes)
curl https://api.rain.yoursite.com/readyz
```

### Key Metrics to Alert On
```
1. Database connection pool exhaustion
2. Login attempt brute force (MAX_FAILURES breaches)
3. Abuse escalation: 3+ new bans in 1 hour
4. Guest account deletion lag (> 5 min backlog)
5. CAPTCHA failure rate > 10%
6. Device reputation scores shifting (potential attack)
7. WebSocket disconnects > 5% per minute
8. Queue time exceeding 60 seconds
9. Unhandled errors in cleanup worker
10. Message volume per user exceeding thresholds
```

### Structured Logging
All events logged as JSON:
```json
{
  "timestamp": "2026-09-18T12:34:56Z",
  "event": "match_reported",
  "level": "info",
  "account_id": "...",
  "match_id": "...",
  "reason": "sexual-content",
  "ip": "...",
  "user_agent": "..."
}
```

Redact:
- Passwords (never logged)
- Session tokens (hash only)
- CSRF tokens (hash only)
- Message content (log only event, not text)
- Device fingerprints (hash only)

---

## Incident Response Playbook

### CSAM Discovered (CRITICAL)
1. **Immediate:** Suspend account and ban device
2. **Within 1 hour:** CyberTipline report (NCMEC)
3. **Within 24 hours:** Law enforcement contact
4. **Document:** Timeline, evidence, actions taken
5. **Legal review:** Liability and preservation

### DDoS Attack
1. **Activate:** Rate limiting surge (already baked in)
2. **Notify:** Load balancer / WAF team
3. **Isolate:** Rate-limit affected IPs/ranges
4. **Monitor:** Queue depth, connection count
5. **Recover:** Gradual scale-up once attack ends

### Database Breach
1. **Shutdown:** All services (prevent further compromise)
2. **Forensics:** Determine scope and timeline
3. **Notification:** Users affected within 72 hours
4. **Passwords:** Force reset on next login
5. **Session revocation:** All active sessions end
6. **Legal/PR:** Crisis communication plan

### High Abuse Volume (Coordinated Attack)
1. **Escalate:** Ban entire IP ranges if needed
2. **Alert:** Moderation team for review
3. **Analyze:** Pattern (sexual content, hate speech, etc.)
4. **Auto-ban:** Similar users (device fingerprint match)
5. **Communication:** Public transparency if widespread

---

## Data Retention & Privacy

### What Is Stored
| Data | Retained | Reason |
|------|----------|--------|
| Account profile | Until deletion | User identity |
| Sessions | 30 days max | Login state |
| Reports | 90 days (then anonymized) | Abuse investigation |
| Audit log | 90 days (then redacted) | Compliance |
| Login attempts | 7 days | Brute-force protection |
| Device fingerprints | 30 days | Abuse pattern detection |
| CAPTCHA challenges | 1 day | Verify submission |
| Match history | 30 days | Moderation context |
| Guest accounts | 0 days (deleted on logout) | Privacy by design |

### User Deletion
```sql
-- User requests account deletion via settings
-- API creates a deletion task
-- Cleanup worker runs in next cycle:
delete from accounts where id = $1;  -- Cascades everything
```

### Data Export (GDPR)
```bash
# User requests export
# API generates JSON of:
# - account.created_at, email, email_verified, terms_accepted_at
# - profile (name, handle, bio, interests)
# - connections (mutual friends list only)
# - inbox (DMs with mutual friends)
# - reports they filed
# - moderation actions against them
```

---

## Scaling Beyond Single Instance

### Horizontal Scaling
- **Web client:** CDN (Cloudflare, Vercel Edge)
- **API:** Load balancer → 2–4 instances (ECS, K8s)
- **Realtime gateway:** Load balancer (sticky sessions off) → 2–4 instances
- **Database:** RDS with read replicas; use PgBouncer for connection pooling
- **Redis:** Cluster mode for distributed queues

### Performance Targets
- **Queue time:** < 30 seconds (p50), < 60 seconds (p99)
- **Message latency:** < 100ms (p50), < 500ms (p99)
- **API response:** < 200ms (p50), < 1s (p99)
- **CAPTCHA verification:** < 2 seconds

---

## Post-Launch Operations

### Daily
- [ ] Monitor error rate and SLOs
- [ ] Review new high-severity abuse reports
- [ ] Check database disk usage
- [ ] Verify backup completion

### Weekly
- [ ] Review moderation action escalations
- [ ] Audit failed login attempts by IP
- [ ] Analyze device reputation trends
- [ ] Test incident response procedures

### Monthly
- [ ] Analyze user retention and churn
- [ ] Review abuse patterns (quarterly report)
- [ ] Update security headers and CSP
- [ ] Patch dependencies and test

### Quarterly
- [ ] Legal review of Terms/Privacy Policy
- [ ] Penetration testing / security audit
- [ ] Data retention anonymization sweep
- [ ] Capacity planning for next quarter

---

## Success Metrics

If Rain is to compete with Omegle/Emerald *and* avoid their failures:

| Metric | Target | Frequency |
|--------|--------|-----------|
| Zero minor accounts | 100% (strict enforcement) | Ongoing |
| Average report response | < 4 hours | Daily |
| Account appeal approval rate | > 10% (fair, not rubber-stamp) | Weekly |
| False CAPTCHA rate | < 2% | Weekly |
| User retention (30 days) | > 20% | Monthly |
| Abuse report volume | Trending down | Monthly |
| Session revocation on ban | 100% | Spot-check |
| Guest cleanup latency | < 5 min | Daily |

---

**Rain is built for safety-first growth. Follow this guide, test thoroughly, and iterate based on real-world incidents. Omegle didn't fail because it was unlucky — it failed because it didn't invest in moderation. You have the tools. Use them.**
