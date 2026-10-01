import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4'
import webpush from 'npm:web-push@3.6.7'

const corsHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
}

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing secret: ${name}`)
  return value
}

async function pushSecrets(admin: SupabaseClient): Promise<{ publicKey: string; privateKey: string; cronSecret: string }> {
  const envPublic = Deno.env.get('VAPID_PUBLIC_KEY')
  const envPrivate = Deno.env.get('VAPID_PRIVATE_KEY')
  const envCron = Deno.env.get('CRON_SECRET')
  if (envPublic && envPrivate && envCron) {
    return { publicKey: envPublic, privateKey: envPrivate, cronSecret: envCron }
  }

  const { data, error } = await admin
    .from('milk_server_secrets')
    .select('name,secret_value')
    .in('name', ['vapid_public_key', 'vapid_private_key', 'cron_secret'])
  if (error) throw error
  const values = Object.fromEntries((data || []).map((row) => [row.name, row.secret_value]))
  if (!values.vapid_public_key || !values.vapid_private_key || !values.cron_secret) {
    throw new Error('Web Push server secrets are not configured')
  }
  return {
    publicKey: values.vapid_public_key,
    privateKey: values.vapid_private_key,
    cronSecret: values.cron_secret,
  }
}

function secretKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const values = JSON.parse(env('SUPABASE_SECRET_KEYS'))
  if (!values.default) throw new Error('Default Supabase secret key is unavailable')
  return values.default
}

Deno.serve(async (request) => {
  try {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })
    const admin = createClient(env('SUPABASE_URL'), secretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const secrets = await pushSecrets(admin)
    webpush.setVapidDetails('mailto:noreply@example.com', secrets.publicKey, secrets.privateKey)

    const input = await request.json().catch(() => ({})) as { action?: string }
    if (input.action === 'test') {
      const authorization = request.headers.get('authorization') || ''
      const token = authorization.replace(/^Bearer\s+/i, '')
      if (!token) return new Response('Unauthorized', { status: 401, headers: corsHeaders })
      const { data: authData, error: authError } = await admin.auth.getUser(token)
      if (authError || !authData.user) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

      const { data: subscriptions, error: subscriptionError } = await admin
        .from('milk_push_subscriptions')
        .select('endpoint,subscription')
        .eq('user_id', authData.user.id)
      if (subscriptionError) throw subscriptionError

      let sent = 0
      let removed = 0
      for (const row of subscriptions || []) {
        try {
          await webpush.sendNotification(row.subscription, JSON.stringify({
            title: 'loveubae',
            body: '测试通知已送达，锁屏推送可以正常使用',
            url: './',
            tag: 'loveubae-push-test',
          }), { TTL: 300 })
          sent += 1
        } catch (pushError) {
          const statusCode = Number((pushError as { statusCode?: number }).statusCode || 0)
          if (statusCode === 404 || statusCode === 410) {
            await admin.from('milk_push_subscriptions').delete()
              .eq('user_id', authData.user.id).eq('endpoint', row.endpoint)
            removed += 1
          } else {
            console.error('Test push failed', authData.user.id, statusCode, pushError)
          }
        }
      }
      return new Response(JSON.stringify({ sent, removed }), { headers: corsHeaders })
    }

    if (request.headers.get('x-cron-secret') !== secrets.cronSecret) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders })
    }

    const now = new Date()
    // 先取所有仍有效的端点，再按用户分组。同一账号即使残留多个设备端点，
    // 每个时间点也只生成一条聊天消息，而不是每个端点各生成一条。
    const { data: activeSubscriptions, error } = await admin
      .from('milk_push_subscriptions')
      .select('*')
      .gt('active_until', now.toISOString())
      .order('updated_at', { ascending: false })
      .limit(500)
    if (error) throw error

    let sent = 0
    let generated = 0
    let removed = 0
    type SubscriptionRow = NonNullable<typeof activeSubscriptions>[number]
    const subscriptionsByUser = new Map<string, SubscriptionRow[]>()
    for (const row of activeSubscriptions || []) {
      const rows = subscriptionsByUser.get(row.user_id) || []
      rows.push(row)
      subscriptionsByUser.set(row.user_id, rows)
    }

    let checked = 0
    for (const [userId, rows] of subscriptionsByUser) {
      if (!rows?.some((row) => new Date(row.next_push_at).getTime() <= now.getTime())) continue
      checked += rows.length
      const profile = rows[0]
      const intervalMinutes = Math.max(1, Math.min(120, Number(profile.push_interval_minutes) || 5))
      const nextPushAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString()
      const pool = Array.isArray(profile.reply_pool) ? profile.reply_pool.filter(Boolean) : []
      if (pool.length === 0) {
        await admin.from('milk_push_subscriptions').update({ next_push_at: nextPushAt }).eq('user_id', userId)
        continue
      }

      const body = String(pool[Math.floor(Math.random() * pool.length)]).slice(0, 280)
      try {
        // 消息先且只落库一次；系统通知失败时，下次打开网页仍然不会丢消息。
        const { data: message, error: messageError } = await admin.from('milk_push_messages')
          .insert({ user_id: userId, body }).select('id').single()
        if (messageError) throw messageError
        const { error: scheduleError } = await admin.from('milk_push_subscriptions').update({ next_push_at: nextPushAt })
          .eq('user_id', userId)
        if (scheduleError) throw scheduleError
        generated += 1

        for (const row of rows) {
          // “完全不显示”只隐藏系统通知，聊天消息仍已保存在上面的待收表。
          if (row.privacy_mode === 'off') continue
          const notification = row.privacy_mode === 'generic'
            ? { title: 'loveubae', body: '您收到了一条新消息', url: './', tag: `loveubae-sleep-message-${message.id}` }
            : { title: row.partner_name || '对方', body, url: './', tag: `loveubae-sleep-message-${message.id}` }
          try {
            await webpush.sendNotification(row.subscription, JSON.stringify(notification), { TTL: 3600 })
            sent += 1
          } catch (pushError) {
            const statusCode = Number((pushError as { statusCode?: number }).statusCode || 0)
            if (statusCode === 404 || statusCode === 410) {
              await admin.from('milk_push_subscriptions').delete()
                .eq('user_id', userId).eq('endpoint', row.endpoint)
              removed += 1
            } else {
              console.error('Push failed', userId, statusCode, pushError)
            }
          }
        }
      } catch (messageError) {
        // 一个账号的数据库错误不能阻断同一轮里的其他账号。
        console.error('Background message failed', userId, messageError)
      }
    }

    return new Response(JSON.stringify({ checked, generated, sent, removed }), { headers: corsHeaders })
  } catch (error) {
    console.error(error)
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: corsHeaders,
    })
  }
})
