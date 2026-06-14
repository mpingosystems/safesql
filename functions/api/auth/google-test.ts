import { json, methodNotAllowed, type Env } from '../../_shared';

// Sprint 12 Part 1 — GET /api/auth/google-test. Confirms the Clerk env vars are
// wired (without exposing their values) to help debug Google OAuth setup.
export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'GET') return methodNotAllowed(['GET']);
  const { env } = context;
  return json({
    clerk_domain: env.CLERK_DOMAIN ?? null,
    has_clerk_secret: !!env.CLERK_SECRET_KEY,
    timestamp: new Date().toISOString(),
  });
};
