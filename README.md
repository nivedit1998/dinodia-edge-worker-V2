# Dinodia Edge Worker V2

This worker is a V2-only edge router. It forwards `/api/*` requests to the configured V2 Vercel origin and has no AWS, old Vercel or per-request backend fallback.

## Configuration

`VERCEL_APP_ORIGIN` must point to the new `dinodia-platform-v2` Vercel deployment. Do not put a database URL, service-role key or other backend secret in this worker.

The checked-in local configuration has no old production route. Add a Cloudflare route only for the isolated V2 release-candidate environment after the Vercel deployment has been verified.

## Validation

```bash
npm ci
npm run typecheck
npx wrangler deploy --dry-run
```

The worker must reject configuration that names AWS or the old platform. It must never select an origin based on a customer request.
