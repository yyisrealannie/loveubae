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

    function friendlyAuthError(error) {
        const message = String((error && error.message) || '请稍后重试');
        if (/invalid login credentials/i.test(message)) {
            return '邮箱或密码不正确；如果这个邮箱以前注册过，请点“忘记密码”';
        }
        if (/email not confirmed/i.test(message)) {
            return '邮箱尚未确认，请点“重新发送验证邮件”并打开最新邮件';
        }
        return message;
    }

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
        client.auth.onAuthStateChange(event => {
            if (event !== 'PASSWORD_RECOVERY') return;
            // Keep the auth callback synchronous; render the recovery UI afterwards.
            setTimeout(() => openRecoveryPanel(), 0);
        });
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
            if (user) {
                const syncState = window.MilkSafeSync?.statusText() || '已连接';
                if (inline) inline.textContent = syncState;
                if (modalStatus) modalStatus.textContent = `已登录 ${user.email || ''} · ${syncState}`;
                return;
            }
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
                <div class="cloud-sync-note">新消息按条追加上传；断网时会留在本机，恢复联网后重试。云端合并不会覆盖本机记录。</div>
                <input class="modal-input" id="cloud-sync-url" inputmode="url" placeholder="Supabase Project URL">
                <input class="modal-input" id="cloud-sync-anon" type="password" placeholder="Supabase anon key">
                <div class="cloud-sync-divider">账户</div>
                <input class="modal-input" id="cloud-sync-email" type="email" autocomplete="email" placeholder="邮箱">
                <input class="modal-input" id="cloud-sync-password" type="password" autocomplete="current-password" placeholder="密码（至少 6 位）">
                <div id="cloud-sync-status" class="cloud-sync-status">尚未连接</div>
                <label class="cloud-auto-row"><input type="checkbox" id="cloud-sync-auto"> 自动及时保存新消息与字卡（推荐）</label>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-signup">注册</button>
                    <button class="modal-btn modal-btn-primary" id="cloud-sync-login">登录</button>
                </div>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-resend">重新发送验证邮件</button>
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-forgot">忘记密码</button>
                </div>
                <div id="cloud-sync-recovery" hidden>
                    <div class="cloud-sync-divider">设置新密码</div>
                    <div class="cloud-sync-note">重置链接已验证。请输入一个没有在其他网站使用过的新密码。</div>
                    <input class="modal-input" id="cloud-sync-new-password" type="password" autocomplete="new-password" placeholder="新密码（至少 8 位）">
                    <input class="modal-input" id="cloud-sync-confirm-password" type="password" autocomplete="new-password" placeholder="再次输入新密码">
                    <div class="cloud-sync-actions">
                        <button class="modal-btn modal-btn-primary" id="cloud-sync-set-password">保存新密码</button>
                    </div>
                </div>
                <div class="cloud-sync-actions">
                    <button class="modal-btn modal-btn-secondary" id="cloud-sync-download"><i class="fas fa-cloud-arrow-down"></i> 合并云端记录（不覆盖）</button>
                    <button class="modal-btn modal-btn-primary" id="cloud-sync-upload"><i class="fas fa-cloud-arrow-up"></i> 立即增量上传</button>
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
        auto.checked = localStorage.getItem(KEYS.auto) !== 'false';

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
                if (mode === 'signup' && result.data?.user && !result.data.session &&
                    Array.isArray(result.data.user.identities) && result.data.user.identities.length === 0) {
                    showNotification('这个邮箱可能已经注册过，请直接登录或点“忘记密码”', 'info', 5500);
                    return;
                }
                password.value = '';
                showNotification(mode === 'signup' ? '注册请求已提交；请查收验证邮件' : '登录成功', 'success', 3500);
                await refreshStatus();
                scheduleAutoSync();
            } catch (e) {
                showNotification('连接失败：' + friendlyAuthError(e), 'error', 6000);
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
        modal.querySelector('#cloud-sync-forgot').addEventListener('click', async () => {
            try {
                const c = saveConfig();
                const targetEmail = email.value.trim();
                if (!targetEmail) throw new Error('请先填写注册时使用的邮箱');
                const result = await c.auth.resetPasswordForEmail(targetEmail, {
                    redirectTo: appBaseUrl()
                });
                if (result.error) throw result.error;
                showNotification('重置邮件已发送，请检查收件箱、垃圾邮件和“推广”分类，并打开最新一封', 'success', 7000);
            } catch (e) {
                showNotification('发送失败：' + friendlyAuthError(e), 'error', 6000);
            }
        });
        modal.querySelector('#cloud-sync-set-password').addEventListener('click', async () => {
            const nextPassword = modal.querySelector('#cloud-sync-new-password');
            const confirmation = modal.querySelector('#cloud-sync-confirm-password');
            try {
                if (nextPassword.value.length < 8) throw new Error('新密码至少需要 8 位');
                if (nextPassword.value !== confirmation.value) throw new Error('两次输入的新密码不一致');
                const c = saveConfig();
                const result = await c.auth.updateUser({ password: nextPassword.value });
                if (result.error) throw result.error;
                nextPassword.value = '';
                confirmation.value = '';
                modal.querySelector('#cloud-sync-recovery').hidden = true;
                showNotification('新密码已保存，现在已登录', 'success', 5000);
                await refreshStatus();
                scheduleAutoSync();
            } catch (e) {
                showNotification('设置失败：' + friendlyAuthError(e), 'error', 6000);
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

    function openRecoveryPanel() {
        const modal = ensureModal();
        modal.querySelector('#cloud-sync-recovery').hidden = false;
        const status = modal.querySelector('#cloud-sync-status');
        if (status) status.textContent = '重置链接已验证，请在下方设置新密码';
        showModal(modal);
        setTimeout(() => modal.querySelector('#cloud-sync-new-password')?.focus(), 50);
    }

    async function upload(options) {
        const quiet = options && options.quiet;
        try {
            if (!window.MilkSafeSync) throw new Error('安全同步模块未加载');
            const result = await window.MilkSafeSync.flush(true);
            await window.MilkSafeSync.syncProfile();
            if (result.error) throw new Error(result.error);
            if (!quiet) showNotification(result.pending
                ? '已上传一部分；还有 '+result.pending+' 条待传，保持页面打开联网会继续上传'
                : '聊天和字卡增量同步完成（大图如不支持会明确提示）', result.pending ? 'info' : 'success', 5000);
            await refreshStatus();
        } catch (e) {
            if (!quiet) showNotification('上传尚未完成：'+(e.message || '未知错误')+'；本机记录未清除', 'error', 6000);
        }
    }

    async function download() {
        const button = document.getElementById('cloud-sync-download');
        const originalHtml = button && button.innerHTML;
        try {
            if (button) {
                button.disabled = true;
                button.textContent = '正在检查云端…';
            }
            showNotification('正在检查云端记录…', 'info', 2500);
            if (!window.MilkSafeSync) throw new Error('安全同步模块未加载');
            const result = await window.MilkSafeSync.mergeRemote();
            showNotification(result.added
                ? '已合并 '+result.added+' 条云端消息，本机原有记录保留'
                : '没有需要合并的新记录；本机内容没有被覆盖', 'success', 5000);
            await refreshStatus();
        } catch (e) {
            showNotification('合并失败：'+(e.message || '未知错误')+'；本机记录未清除', 'error', 6000);
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = originalHtml;
            }
        }
    }

    function scheduleAutoSync() {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
        if (window._milkAppReady && localStorage.getItem(KEYS.auto) !== 'false' && window.MilkSafeSync) {
            window.MilkSafeSync.start().catch(console.warn);
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
