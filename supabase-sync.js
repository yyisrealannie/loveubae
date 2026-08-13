/* ============================================
   Supabase 云端同步模块
   ============================================ */

const SUPABASE_URL = 'https://igaagakerfqzufcmsrqz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnYWFnYWtlcmZxenVmY21zcnF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1Nzc0NzgsImV4cCI6MjA5MTE1MzQ3OH0.faQZzNgqW7vww8LDMokK56ygpkWo0-2JuOBvB9QIMqw';

const SupabaseSync = (() => {
    let deviceId = localStorage.getItem('_device_id');
    if (!deviceId) {
        deviceId = 'dev_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('_device_id', deviceId);
    }

    const headers = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates'
    };

    // 初始化表（如果不存在会自动创建）
    async function ensureTable() {
        // 尝试读取，如果表不存在会报错，我们捕获后提示用户建表
        const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_data?select=id&limit=1`, { headers });
        if (res.status === 404 || res.status === 400) {
            console.warn('[Supabase] 表不存在，请在Supabase控制台建表');
            showSyncStatus('⚠️ 请先建立云端数据表', 'warn');
            return false;
        }
        return true;
    }

    // 上传数据到云端
    async function push(dataObj) {
        try {
            const payload = {
                id: 'main',
                device_id: deviceId,
                data: dataObj,
                updated_at: new Date().toISOString()
            };
            const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_data`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const err = await res.text();
                console.error('[Supabase] 上传失败:', err);
                showSyncStatus('☁️ 同步失败', 'error');
                return false;
            }
            showSyncStatus('☁️ 已同步', 'success');
            localStorage.setItem('_last_sync', new Date().toISOString());
            return true;
        } catch (e) {
            console.error('[Supabase] 网络错误:', e);
            showSyncStatus('☁️ 网络错误', 'error');
            return false;
        }
    }

    // 从云端拉取数据
    async function pull() {
        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_data?id=eq.main&select=*`, { headers });
            if (!res.ok) return null;
            const arr = await res.json();
            if (!arr || arr.length === 0) return null;
            return arr[0].data;
        } catch (e) {
            console.error('[Supabase] 拉取失败:', e);
            return null;
        }
    }

    // 显示同步状态
    function showSyncStatus(msg, type) {
        let el = document.getElementById('sync-status-badge');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sync-status-badge';
            el.style.cssText = `
                position: fixed; top: 12px; right: 12px; z-index: 9999;
                padding: 4px 10px; border-radius: 12px; font-size: 11px;
                backdrop-filter: blur(8px); transition: opacity 0.3s;
                pointer-events: none;
            `;
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        el.style.background = type === 'success' ? 'rgba(100,200,100,0.3)' :
                              type === 'error' ? 'rgba(200,80,80,0.3)' : 'rgba(200,160,80,0.3)';
        el.style.color = type === 'success' ? '#4caf50' :
                         type === 'error' ? '#f44336' : '#ff9800';
        if (type === 'success') {
            setTimeout(() => { el.style.opacity = '0'; }, 3000);
        }
    }

    // 获取上次同步时间
    function getLastSync() {
        const t = localStorage.getItem('_last_sync');
        if (!t) return '从未同步';
        const d = new Date(t);
        return d.toLocaleString('zh-CN');
    }

    return { push, pull, ensureTable, showSyncStatus, getLastSync, deviceId };
})();

window.SupabaseSync = SupabaseSync;
