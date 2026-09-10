(function () {
    'use strict';

    const VAPID_PUBLIC_KEY = 'BJa9hBL-cvAJ-k-c3Am7WyCI9sPTjYAuhTsoDXcBsxV4nv3QAEs06lpuqgbNJlpTHbIEJGi5eUfuylEby4zDkxU';
    const ACTIVE_HOURS = 10;
    const ACTIVE_UNTIL_KEY = 'sleepPushActiveUntil';

    function isStandalone() {
        return window.navigator.standalone === true
            || window.matchMedia('(display-mode: standalone)').matches;
    }

    function base64UrlToBytes(value) {
        const padding = '='.repeat((4 - value.length % 4) % 4);
        const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, char => char.charCodeAt(0));
    }

    function statusElements() {
        return {
            text: document.getElementById('sleep-push-status'),
            button: document.getElementById('sleep-push-enable')
        };
    }

    function localExpiry() {
        return Number(localStorage.getItem(ACTIVE_UNTIL_KEY) || 0);
    }

    function formatTime(timestamp) {
        return new Date(timestamp).toLocaleString('zh-CN', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    async function refreshStatus() {
        const el = statusElements();
        if (!el.text || !el.button) return;
        const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        const expiry = localExpiry();
        if (!supported) {
            el.text.textContent = '当前系统不支持 Web Push';
            el.button.textContent = '不可用';
            el.button.disabled = true;
        } else if (!isStandalone()) {
            el.text.textContent = '请先用 Safari“添加到主屏幕”，再从桌面打开';
            el.button.textContent = '待安装';
            el.button.disabled = true;
        } else if (Notification.permission === 'denied') {
            el.text.textContent = '通知已被系统拒绝，请到 iPhone 设置中允许';
            el.button.textContent = '被阻止';
            el.button.disabled = true;
        } else if (expiry > Date.now()) {
            el.text.textContent = '已开启，持续到 ' + formatTime(expiry);
            el.button.textContent = '续10小时';
            el.button.disabled = false;
        } else {
            el.text.textContent = '锁屏或切换 App 后仍可接收系统推送';
            el.button.textContent = '开启';
            el.button.disabled = false;
        }
    }

    function replyPool() {
        let pool = [];
        try {
            if (typeof customReplies !== 'undefined' && Array.isArray(customReplies)) pool = customReplies.slice();
            else if (Array.isArray(window._customReplies)) pool = window._customReplies.slice();
        } catch (e) {}
        let disabled = new Set();
        try { disabled = new Set(JSON.parse(localStorage.getItem('disabledReplyItems') || '[]')); } catch (e) {}
        return Array.from(new Set(pool
            .map(item => String(item || '').trim())
            .filter(item => item && !disabled.has(item))))
            .slice(0, 300)
            .map(item => item.slice(0, 280));
    }

    async function cloudIdentity() {
        if (!window.MilkCloudSync) throw new Error('Supabase 同步模块尚未加载');
        const client = window.MilkCloudSync.getClient();
        const user = await window.MilkCloudSync.currentUser();
        if (!client || !user) throw new Error('请先在“Supabase 同步”中登录');
        return { client, user };
    }

    async function currentSubscription(createIfMissing) {
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription && createIfMissing) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY)
            });
        }
        return subscription;
    }

    async function enableFor10Hours() {
        try {
            if (!isStandalone()) throw new Error('请先用 Safari 把网站添加到主屏幕，并从桌面图标打开');
            const identity = await cloudIdentity();
            if (replyPool().length === 0) throw new Error('字卡回复库为空，请先添加至少一条字卡');
            const permission = Notification.permission === 'granted'
                ? 'granted'
                : await Notification.requestPermission();
            if (permission !== 'granted') throw new Error('需要允许通知，锁屏后才能收到消息');

            const subscription = await currentSubscription(true);
            const now = Date.now();
            const activeUntil = new Date(now + ACTIVE_HOURS * 60 * 60 * 1000);
            const nextPush = new Date(now + (20 + Math.random() * 25) * 60 * 1000);
            const payload = {
                user_id: identity.user.id,
                endpoint: subscription.endpoint,
                subscription: subscription.toJSON(),
                partner_name: (typeof settings !== 'undefined' && settings.partnerName) || '对方',
                privacy_mode: localStorage.getItem('notifPrivacyMode') || 'full',
                reply_pool: replyPool(),
                active_until: activeUntil.toISOString(),
                next_push_at: nextPush.toISOString(),
                updated_at: new Date().toISOString()
            };
            const result = await identity.client.from('milk_push_subscriptions')
                .upsert(payload, { onConflict: 'user_id,endpoint' });
            if (result.error) throw result.error;
            localStorage.setItem(ACTIVE_UNTIL_KEY, String(activeUntil.getTime()));
            localStorage.setItem('notifEnabled', '1');
            await refreshStatus();
            if (typeof showNotification === 'function') {
                showNotification('睡眠推送已开启 10 小时，可以锁屏睡觉了', 'success', 4200);
            }
        } catch (error) {
            if (typeof showNotification === 'function') {
                showNotification('睡眠推送未开启：' + (error.message || '请稍后重试'), 'error', 6000);
            }
        }
    }

    async function syncProfile(options) {
        try {
            const identity = await cloudIdentity();
            const subscription = await currentSubscription(false);
            if (!subscription) return;
            const result = await identity.client.from('milk_push_subscriptions').update({
                partner_name: (typeof settings !== 'undefined' && settings.partnerName) || '对方',
                privacy_mode: localStorage.getItem('notifPrivacyMode') || 'full',
                reply_pool: replyPool(),
                updated_at: new Date().toISOString()
            }).eq('user_id', identity.user.id).eq('endpoint', subscription.endpoint);
            if (result.error) throw result.error;
        } catch (error) {
            if (!(options && options.quiet) && typeof showNotification === 'function') {
                showNotification('推送资料同步失败：' + (error.message || '未知错误'), 'error', 4500);
            }
        }
    }

    async function importPendingMessages() {
        try {
            if (typeof addMessage !== 'function') return;
            const identity = await cloudIdentity();
            const result = await identity.client.from('milk_push_messages')
                .select('id,body,sent_at')
                .is('imported_at', null)
                .order('sent_at', { ascending: true })
                .limit(50);
            if (result.error || !result.data || !result.data.length) return;
            result.data.forEach(item => addMessage({
                id: Date.parse(item.sent_at) || Date.now(),
                sender: (typeof settings !== 'undefined' && settings.partnerName) || '对方',
                text: item.body,
                timestamp: new Date(item.sent_at),
                status: 'received',
                favorited: false,
                note: null,
                type: 'normal'
            }));
            await identity.client.from('milk_push_messages')
                .update({ imported_at: new Date().toISOString() })
                .in('id', result.data.map(item => item.id));
        } catch (e) {}
    }

    window.SleepPush = { enableFor10Hours, refreshStatus, syncProfile, importPendingMessages };
    document.addEventListener('DOMContentLoaded', function () {
        refreshStatus();
        setTimeout(importPendingMessages, 3500);
    });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            refreshStatus();
            setTimeout(importPendingMessages, 800);
        }
    });
})();
