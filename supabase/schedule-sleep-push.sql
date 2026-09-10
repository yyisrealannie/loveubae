-- 先把下面的 YOUR_CRON_SECRET 换成你自己生成的一长串随机字符，并确保
-- 它与 Edge Function Secrets 中 CRON_SECRET 的值完全相同。

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

select vault.create_secret(
  'https://igaagakerfqzufcmsrqz.supabase.co',
  'loveubae_project_url'
);

select vault.create_secret(
  'YOUR_CRON_SECRET',
  'loveubae_cron_secret'
);

select cron.unschedule(jobid)
from cron.job
where jobname = 'loveubae-sleep-push';

select cron.schedule(
  'loveubae-sleep-push',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'loveubae_project_url') || '/functions/v1/sleep-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'loveubae_cron_secret')
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $$
);
