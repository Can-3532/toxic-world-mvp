# TOXIC WORLD — Environment Variables (template)

> The platform blocks the literal `.env.example` filename in this workspace;
> this file is the equivalent template. Names only — never commit real values.
> In Freebuff Web, secrets are managed in the project **Keys / API keys** UI
> and injected automatically; most vars below are auto-set by the platform.

## Convex (auto-set by the Freebuff platform)

```
CONVEX_DEPLOYMENT=
VITE_CONVEX_URL=
```

## Convex Auth (self-issued JWTs / OIDC)

```
CONVEX_SITE_URL=
SITE_URL=
JWKS=
JWT_PRIVATE_KEY=
VLY_CONVEX_AUTH_ISSUER=https://freebuff.com
```

## Freebuff app shell + VLY integrations (auto-set)

```
VITE_VLY_APP_ID=
VITE_VLY_MONITORING_URL=
VLY_APP_NAME=TOXIC WORLD
VLY_INTEGRATION_KEY=
VLY_INTEGRATION_BASE_URL=https://integrations.freebuff.com/
```

## Email OTP

Uses the freebuff auth gateway (`src/convex/auth/emailOtp.ts`); the gateway API
key is currently hardcoded in that file.

---

## PLANNED — REAL SOLANA RAIL (NOT READ ANYWHERE IN THE CODEBASE TODAY)

Add these only when the settlement integration is wired up:

```
COINBASE_COMMERCE_API_KEY=
COINBASE_COMMERCE_WEBHOOK_SECRET=
SOLANA_TREASURY_PRIVATE_KEY=
```
