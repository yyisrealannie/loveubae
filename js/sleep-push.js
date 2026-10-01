(function () {
    'use strict';

    const VAPID_PUBLIC_KEY = 'BNFR1ut7XUBWxqJGSQogCGj8fuPBn-hSOsxCs51q4OiCvqVh7HOfUh2cfA1T8Eo6WYtHLNVweJzPUJ_LeuF7p0c';
    const ACTIVE_UNTIL_KEY = 'sleepPushActiveUntil';
    const DURATION_KEY = 'sleepPushDurationHours';
    let pendingImportPromise = null;
    let pendingImportTimer = null;

    function isStandalone() {
        return window.navigator.standalone === true
            || window.matchMedia('(display-mode: standalone)').matches;
    }

    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function iosVersion() {
        const match = navigator.userAgent.match(/OS (\d+)[._](\d+)/);
        return match ? Number(match[1]) + Number(match[2]) / 10 : null;
    }

    function base64UrlToBytes(value) {
        const padding = '='.repeat((4 - value.length % 4) % 4);
        const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, char => char.charCodeAt(0));
    }

    function statusElements() {
        return {
            text: document.getElementById('sleep-push-status'),
            button: document.getElementById('sleep-push-enable'),
            test: document.getElementById('sleep-push-test'),
            disable: document.getElementById('sleep-push-disable'),
            hours: document.getElementById('sleep-push-hours'),
            hoursValue: document.getElementById('sleep-push-hours-value'),
            frequency: document.getElementById('sleep-push-frequency'),
            interval: document.getElementById('sleep-push-interval'),
            intervalValue: document.getElementById('sleep-push-interval-value')
        };
    }

    function selectedHours() {
        const value = Number(localStorage.getItem(DURATION_KEY) || 10);
        return Math.max(1, Math.min(24, Number.isFinite(value) ? value : 10));
    }

    function intervalMinutes() {
        let value = 5;
        try {
            if (typeof settings !== 'undefined') value = Number(settings.autoSendInterval || 5);
        } catch (e) {}
        return Math.max(1, Math.min(120, Number.isFinite(value) ? Math.round(value) : 5));
    }

    function setDuration(value) {
        const hours = Math.max(1, Math.min(24, Number(value) || 10));
        localStorage.setItem(DURATION_KEY, String(hours));
        refreshStatus();
    }

    function setPushInterval(value, options) {
        const minutes = Math.max(1, Math.min(120, Math.round(Number(value) || 5)));
        try {
            if (typeof settings !== 'undefined') settings.autoSendInterval = minutes;
        } catch (e) {}
        const dataSlider = document.getElementById('sleep-push-interval');
        const dataValue = document.getElementById('sleep-push-interval-value');
        const chatSlider = document.getElementById('auto-send-slider');
        const chatValue = document.getElementById('auto-send-value');
        if (dataSlider) dataSlider.value = String(minutes);
        if (dataValue) dataValue.textContent = minutes + '分钟';
        if (chatSlider) chatSlider.value = String(minutes);
        if (chatValue) chatValue.textContent = minutes + '分钟';
        refreshStatus();
        if (!options || options.persist !== false) {
            if (typeof manageAutoSendTimer === 'function') manageAutoSendTimer();
            if (typeof throttledSaveData === 'function') throttledSaveData();
            syncProfile({ quiet: true, reschedule: true });
        }
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
        const hours = selectedHours();
        if (el.hours) el.hours.value = String(hours);
        if (el.hoursValue) el.hoursValue.textContent = hours + '小时';
        if (el.interval) el.interval.value = String(intervalMinutes());
        if (el.intervalValue) el.intervalValue.textContent = intervalMinutes() + '分钟';
        const privacyMode = localStorage.getItem('notifPrivacyMode') || 'full';
        if (el.frequency) el.frequency.textContent = privacyMode === 'off'
            ? '后台生成后保存到聊天，不弹系统通知 · 当前每 ' + intervalMinutes() + ' 分钟一条'
            : '后台生成后立即推送 · 当前每 ' + intervalMinutes() + ' 分钟一条';
        const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        const expiry = localExpiry();
        let subscription = null;
        if (supported && Notification.permission === 'granted') {
            try { subscription = await currentSubscription(false); } catch (error) {
                console.warn('[sleep-push] 无法读取本机推送订阅', error);
            }
        }
        if (isIOS() && !isStandalone()) {
            el.text.textContent = '请用 Safari 添加到主屏幕，再从桌面图标打开';
            el.button.textContent = '待安装';
            el.button.disabled = true;
            if (el.test) el.test.disabled = true;
            if (el.disable) el.disable.disabled = true;
        } else if (!supported) {
            const version = isIOS() ? iosVersion() : null;
            el.text.textContent = version && version < 16.4
                ? '需要升级到 iOS 16.4 或更高版本'
                : '当前浏览器不支持系统推送，请换 Safari 或更新浏览器';
            el.button.textContent = '不可用';
            el.button.disabled = true;
            if (el.test) el.test.disabled = true;
            if (el.disable) el.disable.disabled = true;
        } else if (Notification.permission === 'denied') {
            el.text.textContent = '通知已被系统拒绝，请到 iPhone 设置中允许';
            el.button.textContent = '被阻止';
            el.button.disabled = true;
            if (el.test) el.test.disabled = true;
            if (el.disable) el.disable.disabled = expiry <= Date.now();
        } else if (expiry > Date.now() && !subscription) {
            el.text.textContent = Notification.permission === 'granted'
                ? '这台手机的推送订阅已失效，请重新开启'
                : '通知授权未完成，请重新开启并允许通知';
            el.button.textContent = '重新开启';
            el.button.disabled = false;
            if (el.test) el.test.disabled = true;
            if (el.disable) el.disable.disabled = false;
        } else if (expiry > Date.now()) {
            el.text.textContent = privacyMode === 'off'
                ? '后台消息已开启，持续到 ' + formatTime(expiry) + '（不弹通知）'
                : '已开启，持续到 ' + formatTime(expiry);
            el.button.textContent = '续' + hours + '小时';
            el.button.disabled = false;
            if (el.test) el.test.disabled = false;
            if (el.disable) el.disable.disabled = false;
        } else {
            el.text.textContent = '锁屏或切换 App 后仍可接收系统推送';
            el.button.textContent = '开启';
            el.button.disabled = false;
            if (el.test) el.test.disabled = true;
            if (el.disable) el.disable.disabled = expiry <= 0;
        }
    }

    function replyPool() {
        return Array.from(new Set(window.getEnabledReplyPool()))
            .slice(0, 300)
            .map(item => item.slice(0, 280));
    }

    let profileSyncChain = Promise.resolve();
    function scheduleProfileSync() {
        // 即使本机 activeUntil 丢失，也要更新仍存在的云端订阅；顺序上传避免旧请求覆盖新状态。
        profileSyncChain = profileSyncChain.then(() => syncProfile()).catch(error => {
            console.warn('[sleep-push] 字卡池同步失败', error);
        });
        return profileSyncChain;
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
        if (createIfMissing) {
            try { await registration.update(); } catch (e) {}
        }
        let subscription = await registration.pushManager.getSubscription();
        if (subscription && createIfMissing && subscription.options && subscription.options.applicationServerKey) {
            const savedKey = new Uint8Array(subscription.options.applicationServerKey);
            const currentKey = base64UrlToBytes(VAPID_PUBLIC_KEY);
            const keyMatches = savedKey.length === currentKey.length
                && savedKey.every((value, index) => value === currentKey[index]);
            if (!keyMatches) {
                await subscription.unsubscribe();
                subscription = null;
            }
        }
        if (!subscription && createIfMissing) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY)
            });
        }
        return subscription;
    }

    async function enable() {
        try {
            if (isIOS() && !isStandalone()) throw new Error('请先用 Safari 把网站添加到主屏幕，并从桌面图标打开');
            if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
                throw new Error('当前浏览器无法创建系统推送，请更新系统或改用 Safari');
            }
            const identity = await cloudIdentity();
            if (replyPool().length === 0) throw new Error('字卡回复库为空，请先添加至少一条字卡');
            const permission = Notification.permission === 'granted'
                ? 'granted'
                : await Notification.requestPermission();
            if (permission !== 'granted') throw new Error('需要允许通知，锁屏后才能收到消息');

            const subscription = await currentSubscription(true);
            const now = Date.now();
            const hours = selectedHours();
            const interval = intervalMinutes();
            const activeUntil = new Date(now + hours * 60 * 60 * 1000);
            const nextPush = new Date(now + interval * 60 * 1000);
            const payload = {
                user_id: identity.user.id,
                endpoint: subscription.endpoint,
                subscription: subscription.toJSON(),
                partner_name: (typeof settings !== 'undefined' && settings.partnerName) || '对方',
                privacy_mode: localStorage.getItem('notifPrivacyMode') || 'full',
                reply_pool: replyPool(),
                active_until: activeUntil.toISOString(),
                next_push_at: nextPush.toISOString(),
                push_interval_minutes: interval,
                updated_at: new Date().toISOString()
            };
            const result = await identity.client.from('milk_push_subscriptions')
                .upsert(payload, { onConflict: 'user_id,endpoint' });
            if (result.error) throw result.error;
            // 同一账号只保留当前手机的系统推送端点。旧端点会造成每轮后台任务重复生成消息。
            const cleanup = await identity.client.from('milk_push_subscriptions')
                .delete().eq('user_id', identity.user.id).neq('endpoint', subscription.endpoint);
            if (cleanup.error) console.warn('[sleep-push] 旧推送端点清理失败，将由云端按账号去重', cleanup.error);
            localStorage.setItem(ACTIVE_UNTIL_KEY, String(activeUntil.getTime()));
            localStorage.setItem('notifEnabled', '1');
            if (typeof manageAutoSendTimer === 'function') manageAutoSendTimer();
            await refreshStatus();
            if (typeof showNotification === 'function') {
                showNotification('睡眠推送已开启 ' + hours + ' 小时；消息生成后会立即推送', 'success', 4200);
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
            const updates = {
                partner_name: (typeof settings !== 'undefined' && settings.partnerName) || '对方',
                privacy_mode: localStorage.getItem('notifPrivacyMode') || 'full',
                reply_pool: replyPool(),
                push_interval_minutes: intervalMinutes(),
                updated_at: new Date().toISOString()
            };
            if (options && options.reschedule && localExpiry() > Date.now()) {
                updates.next_push_at = new Date(Date.now() + intervalMinutes() * 60 * 1000).toISOString();
            }
            const result = await identity.client.from('milk_push_subscriptions').update(updates)
                .eq('user_id', identity.user.id).eq('endpoint', subscription.endpoint);
            if (result.error) throw result.error;
        } catch (error) {
            if (!(options && options.quiet) && typeof showNotification === 'function') {
                showNotification('推送资料同步失败：' + (error.message || '未知错误'), 'error', 4500);
            }
        }
    }

    async function test() {
        try {
            const identity = await cloudIdentity();
            const subscription = await currentSubscription(false);
            if (Notification.permission !== 'granted') throw new Error('请点“重新开启”，并允许系统通知');
            if (!subscription) throw new Error('这台手机的推送订阅已失效，请点“重新开启”');
            const result = await identity.client.functions.invoke('sleep-push', {
                body: { action: 'test' }
            });
            if (result.error) throw result.error;
            if (!result.data || !result.data.sent) throw new Error('测试消息未送出，请重新开启后再试');
            if (typeof showNotification === 'function') {
                showNotification('测试推送已发送，请锁屏或切换 App 查看', 'success', 4200);
            }
        } catch (error) {
            if (typeof showNotification === 'function') {
                showNotification('测试失败：' + (error.message || '请稍后重试'), 'error', 6000);
            }
        }
    }

    async function disable() {
        try {
            const identity = await cloudIdentity();
            const subscription = await currentSubscription(false);
            // 即使本机 PushSubscription 已丢失，也要关闭账号下遗留的云端端点。
            const result = await identity.client.from('milk_push_subscriptions')
                .delete().eq('user_id', identity.user.id);
            if (result.error) throw result.error;
            if (subscription) await subscription.unsubscribe();
            localStorage.removeItem(ACTIVE_UNTIL_KEY);
            localStorage.setItem('notifEnabled', '0');
            if (typeof manageAutoSendTimer === 'function') manageAutoSendTimer();
            await refreshStatus();
            if (typeof showNotification === 'function') {
                showNotification('锁屏推送已关闭；聊天记录没有删除', 'success', 3000);
            }
        } catch (error) {
            if (typeof showNotification === 'function') {
                showNotification('关闭失败：' + (error.message || '请稍后重试'), 'error', 5000);
            }
        }
    }

    function importPendingMessages() {
        // DOMContentLoaded、回到前台和 Service Worker 通知可能同时触发导入。
        // 共用同一个 Promise，保证同一批待收消息只读取、写入一次。
        if (pendingImportPromise) return pendingImportPromise;
        pendingImportPromise = (async function () {
            try {
                if (typeof addMessage !== 'function') return 0;
                const identity = await cloudIdentity();
                const result = await identity.client.from('milk_push_messages')
                    .select('id,body,sent_at')
                    .is('imported_at', null)
                    .order('sent_at', { ascending: true })
                    .limit(500);
                if (result.error) throw result.error;
                if (!result.data || !result.data.length) return 0;

                let added = 0;
                const existing = new Set(
                    typeof messages !== 'undefined' && Array.isArray(messages)
                        ? messages.map(item => String(item.syncId || ''))
                        : []
                );
                result.data.forEach(item => {
                    if (window.isReplyCardDisabled?.(String(item.body || ''))) return;
                    const syncId = 'push:' + item.id;
                    if (existing.has(syncId)) return;
                    const message = {
                        id: 'push-' + item.id,
                        // 推送表的 UUID 跨刷新、跨设备保持不变。
                        syncId,
                        sender: (typeof settings !== 'undefined' && settings.partnerName) || '对方',
                        text: item.body,
                        timestamp: new Date(item.sent_at),
                        status: 'received',
                        favorited: false,
                        note: null,
                        type: 'normal'
                    };
                    messages.push(message);
                    existing.add(syncId);
                    added += 1;
                });

                // 一批积压消息只排序、渲染和保存一次，避免逐条操作 DOM 看起来像慢慢补出。
                if (added > 0) {
                    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                    if (typeof renderMessages === 'function') renderMessages(false);
                    if (typeof saveData === 'function') await saveData();
                    if (window.MilkSafeSync?.flush) window.MilkSafeSync.flush().catch(console.warn);
                }

                const update = await identity.client.from('milk_push_messages')
                    .update({ imported_at: new Date().toISOString() })
                    .in('id', result.data.map(item => item.id));
                if (update.error) throw update.error;
                // 超过 500 条时继续整批吸收，但每批仍只刷新一次页面。
                if (result.data.length === 500) schedulePendingImport(0);
                return added;
            } catch (error) {
                console.warn('[sleep-push] 待收消息导入失败，将在下次唤醒时重试', error);
                return 0;
            } finally {
                pendingImportPromise = null;
            }
        })();
        return pendingImportPromise;
    }

    function schedulePendingImport(delay) {
        if (pendingImportTimer) clearTimeout(pendingImportTimer);
        pendingImportTimer = setTimeout(function () {
            pendingImportTimer = null;
            importPendingMessages();
        }, Math.max(0, Number(delay) || 0));
    }

    window.SleepPush = { enable, disable, test, setDuration, setPushInterval, refreshStatus, syncProfile, scheduleProfileSync, importPendingMessages };
    document.addEventListener('DOMContentLoaded', function () {
        refreshStatus();
    });
    window.addEventListener('milk-app-ready', function () {
        scheduleProfileSync();
        // 必须等本机历史读取完成后再合并推送消息，否则 loadData 可能覆盖刚导入的内容。
        schedulePendingImport(0);
    });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            refreshStatus();
            scheduleProfileSync();
            if (window._milkAppReady) schedulePendingImport(0);
        }
    });
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', function (event) {
            if (event.data && event.data.type === 'milk-push-arrived') {
                // Edge Function 在推送成功后紧接着落库，稍候片刻读取；互斥锁会挡住并发。
                if (pendingImportTimer) clearTimeout(pendingImportTimer);
                pendingImportTimer = setTimeout(async function () {
                    pendingImportTimer = null;
                    const added = await importPendingMessages();
                    // 极少数网络下通知会比数据库落库快，再补一次即可。
                    if (added === 0) schedulePendingImport(1200);
                }, 450);
            }
        });
    }
})();
