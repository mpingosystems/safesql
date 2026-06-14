export interface Env {
  DIGEST_ENDPOINT: string;
  DIGEST_CRON_SECRET: string;
}

// Standalone scheduled Worker — Pages Functions can't run cron triggers, so this
// fires the digest endpoint on a schedule. The endpoint verifies x-cron-secret.
export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const res = await fetch(env.DIGEST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': env.DIGEST_CRON_SECRET,
      },
      body: JSON.stringify({ trigger: 'cron', frequency: 'weekly' }),
    });
    console.log(`Digest cron fired: ${res.status}`);
  },
};
