(function () {
    'use strict';

    const KEYS = {
        url: 'milkSupabaseUrl',
        anon: 'milkSupabaseAnonKey',
        auto: 'milkCloudAutoSync',
        last: 'milkCloudLastSyncAt'
    };
    const DEFAULT_CONFIG = {
        url: 'https://igaagakerfqzufcmsrqz.supabase.co',
        anon: 'sb_publishable_qNI8vffwe415viLNjhRZjQ_ZBZCaKzn'
    };
    let client = null;
    let autoTimer = null;

    function esc(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function projectUrl() {
        return localStorage.getItem(KEYS.url) || DEFAULT_CONFIG.url;
    }

    function publishableKey() {
        return localStorage.getItem(KEYS.anon) || DEFAULT_CONFIG.anon;
    }

    function appBaseUrl() {
        return new URL('./', window.location.href).href;
    }

    function configured() {
        return !!(projectUrl() && publishableKey());
    }

    function getClient() {
        if (client) return client;
        if (!configured() || !window.supabase) return null;
        client = window.supabase.createClient(
            projectUrl(),
            publishableKey(),
            { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
        );
        return client;
    }

    async function currentUser() {
        const c = getClient();
        if (!c) return null;
        const result = await c.auth.getUser();
        return result.data && result.data.user;
    }

    function formatLastSync() {
        const value = Number(localStorage.getItem(KEYS.last) || 0);
        return value ? new Date(value).toLocaleString('zh-CN') : '从未同步';
    }

    async function refreshStatus() {
        const inline = document.getElementById('cloud-sync-inline-status');
        const modalStatus = document.getElementById('cloud-sync-status');
        let text = configured() ? '已配置，尚未登录' : '尚未连接';
        try {
            const user = await currentUser();
            if (user) text = `已登录 ${user.email || ''} · ${formatLastSync()}`;
        } catch (e) {}
        if (inline) inline.textContent = text;
        if (modalStatus) modalStatus.textContent = text;
    }

    function ensureModal() {
        let modal = document.getElementById('cloud-sync-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'cloud-sync-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content cloud-sync-card">
                <div class="modal-title"><i class="fas fa-cloud"></i><span>跨设备同步</span></div>
                <div class="cloud-sync-note">Supabase 项目已连接。首次使用请注册并登录；完成建表后即可上传和恢复记录。</div>
                <input class="modal-input" id="cloud-sync-url" inputmode="url" placeholder="Supabase Project URL">
                <input class="modal-input" id="cloud-sync-anon" type="password" placeholder="Supabase anon key">
                <div class="cloud-sync-divider">账户</div>
                <input class="modal-input" id="cloud-sync-email" type="email" autocomplete="email" placeholder="邮箱">
                <input class="modal-input" id="cloud-sync-password" type="password" autocomplete="current-password" placeholder="密码（至少 6 位）">
                <div id="cloud-sync-status" class="cloud-sync-status">尚未连接</div>
                <label class="cloud-auto-row"><input type="checkbox" id="cloud-sync-auto"> 每 5 分钟自动上传一次</label>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-signup">注册</button>
                    <button class="modal-btn modal-btn-primary" id="cloud-sync-login">登录</button>
                </div>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-resend">重新发送验证邮件</button>
                </div>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-download"><i class="fas fa-cloud-arrow-down"></i> 从云端恢复</button>
                    <button class="modal-btn modal-btn-primary" id="cloud-sync-upload"><i class="fas fa-cloud-arrow-up"></i> 上传当前数据</button>
                </div>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-logout">退出登录</button>
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-close">关闭</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        const url = modal.querySelector('#cloud-sync-url');
        const anon = modal.querySelector('#cloud-sync-anon');
        const email = modal.querySelector('#cloud-sync-email');
        const password = modal.querySelector('#cloud-sync-password');
        const auto = modal.querySelector('#cloud-sync-auto');
        url.value = projectUrl();
        anon.value = publishableKey();
        auto.checked = localStorage.getItem(KEYS.auto) === 'true';

        function saveConfig() {
            const nextUrl = url.value.trim().replace(/\/$/, '');
            const nextAnon = anon.value.trim();
            if (!nextUrl || !nextAnon) throw new Error('请先填写 Project URL 和 anon key');
            if (!/^https:\/\//i.test(nextUrl)) throw new Error('Project URL 必须以 https:// 开头');
            localStorage.setItem(KEYS.url, nextUrl);
            localStorage.setItem(KEYS.anon, nextAnon);
            client = null;
            return getClient();
        }

        async function auth(mode) {
            try {
                const c = saveConfig();
                const credentials = { email: email.value.trim(), password: password.value };
                if (!credentials.email || credentials.password.length < 6) throw new Error('请输入邮箱和至少 6 位密码');
                const result = mode === 'signup'
                    ? await c.auth.signUp({
                        ...credentials,
                        options: { emailRedirectTo: appBaseUrl() }
                    })
                    : await c.auth.signInWithPassword(credentials);
                if (result.error) throw result.error;
                showNotification(mode === 'signup' ? '注册成功；如开启邮箱验证，请先查收邮件' : '登录成功', 'success', 3500);
                await refreshStatus();
                scheduleAutoSync();
            } catch (e) {
                showNotification('连接失败：' + (e.message || '请检查配置'), 'error', 5000);
            }
        }

        modal.querySelector('#cloud-sync-signup').addEventListener('click', () => auth('signup'));
        modal.querySelector('#cloud-sync-login').addEventListener('click', () => auth('login'));
        modal.querySelector('#cloud-sync-resend').addEventListener('click', async () => {
            try {
                const c = saveConfig();
                const targetEmail = email.value.trim();
                if (!targetEmail) throw new Error('请先填写注册邮箱');
                const result = await c.auth.resend({
                    type: 'signup',
                    email: targetEmail,
                    options: { emailRedirectTo: appBaseUrl() }
                });
                if (result.error) throw result.error;
                showNotification('新的验证邮件已发送，请查看最新一封邮件', 'success', 4000);
            } catch (e) {
                showNotification('发送失败：' + (e.message || '请稍后重试'), 'error', 5000);
            }
        });
        modal.querySelector('#cloud-sync-upload').addEventListener('click', upload);
        modal.querySelector('#cloud-sync-download').addEventListener('click', download);
        modal.querySelector('#cloud-sync-logout').addEventListener('click', async () => {
            const c = getClient();
            if (c) await c.auth.signOut();
            await refreshStatus();
        });
        modal.querySelector('#cloud-sync-close').addEventListener('click', () => hideModal(modal));
        modal.addEventListener('click', e => { if (e.target === modal) hideModal(modal); });
        auto.addEventListener('change', () => {
            localStorage.setItem(KEYS.auto, String(auto.checked));
            scheduleAutoSync();
        });
        return modal;
    }

    async function upload(options) {
        const quiet = options && options.quiet;
        try {
            const c = getClient();
            const user = await currentUser();
            if (!c || !user) throw new Error('请先配置并登录');
            await saveData();
            const payload = await ChatBackup.buildBackupPayload({
                inclMsgs: true, inclSet: true, inclCustom: true, inclAnn: true,
                inclThemes: true, inclDg: true, inclStickers: true
            });
            const result = await c.from('milk_sync').upsert({
                user_id: user.id,
                payload,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });
            if (result.error) throw result.error;
            localStorage.setItem(KEYS.last, String(Date.now()));
            if (!quiet) showNotification('当前数据已上传云端', 'success');
            await refreshStatus();
        } catch (e) {
            if (!quiet) showNotification('上传失败：' + (e.message || '未知错误'), 'error', 5000);
        }
    }

    async function download() {
        try {
            const c = getClient();
            const user = await currentUser();
            if (!c || !user) throw new Error('请先配置并登录');
            const result = await c.from('milk_sync').select('payload,updated_at').eq('user_id', user.id).maybeSingle();
            if (result.error) throw result.error;
            if (!result.data || !result.data.payload) throw new Error('云端还没有备份');
            if (!confirm(`将用云端数据覆盖本机对应数据。\n云端更新时间：${new Date(result.data.updated_at).toLocaleString('zh-CN')}\n\n确定继续吗？`)) return;
            await ChatBackup.applyBackupToStorage(result.data.payload, { selective: false });
            await loadData();
            renderMessages();
            updateUI();
            localStorage.setItem(KEYS.last, String(Date.now()));
            showNotification('云端数据已恢复并立即生效', 'success', 3000);
            await refreshStatus();
        } catch (e) {
            showNotification('恢复失败：' + (e.message || '未知错误'), 'error', 5000);
        }
    }

    function scheduleAutoSync() {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
        if (localStorage.getItem(KEYS.auto) === 'true' && configured()) {
            autoTimer = setInterval(() => upload({ quiet: true }), 5 * 60 * 1000);
        }
    }

    window.MilkCloudSync = {
        open: async function () {
            const modal = ensureModal();
            showModal(modal);
            await refreshStatus();
        },
        upload,
        download,
        getClient,
        currentUser,
        refreshStatus
    };

    document.addEventListener('DOMContentLoaded', function () {
        scheduleAutoSync();
        refreshStatus();
    });
})();
