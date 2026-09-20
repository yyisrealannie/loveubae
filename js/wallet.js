(function () {
    'use strict';
    let client, user, panel, updating = false, account = null;
    const format = cents => `¥${(Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const byId = id => document.getElementById(id);
    function toast(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(message, type, 4500);
        else window.alert(message);
    }
    function cents(value) {
        const clean = String(value || '').trim();
        if (!/^\d{1,9}(\.\d{1,2})?$/.test(clean)) throw new Error('请输入正金额，最多两位小数');
        const [yuan, fen = ''] = clean.split('.');
        const number = Number(yuan) * 100 + Number(fen.padEnd(2, '0'));
        if (!Number.isSafeInteger(number) || number < 1 || number > 10000000000) throw new Error('单笔请输入 ¥0.01 到 ¥100,000,000');
        return number;
    }
    function eligibleCards() {
        const replies = typeof customReplies !== 'undefined' ? customReplies : window._customReplies;
        if (!Array.isArray(replies)) return [];
        let disabled = new Set();
        try { disabled = new Set(JSON.parse(localStorage.getItem('disabledReplyItems') || '[]')); } catch (_) {}
        const groups = new Set();
        (window.customReplyGroups || []).forEach(g => { if (g.disabled) (g.items || []).forEach(x => groups.add(x)); });
        return replies.filter(x => typeof x === 'string' && x.trim() && !disabled.has(x) && !groups.has(x));
    }
    function randomAmount() {
        const specials = ['5.20','52.00','520.00','13.14','131.40','1314.00','888.00','666.00','999.00','1212.00','9.50','95.00','95.20','950.00'];
        return Math.random() < .18 ? specials[Math.floor(Math.random() * specials.length)] : ((100 + Math.floor(Math.random() * 19900)) / 100).toFixed(2);
    }
    function ensurePanel() {
        if (panel) return panel;
        panel = document.createElement('section');
        panel.className = 'wallet-panel'; panel.id = 'wallet-panel'; panel.setAttribute('aria-label','红包与转账');
        panel.innerHTML = `<div class="wallet-shell">
            <div class="wallet-panel-header"><button type="button" id="wallet-close" aria-label="返回聊天">←</button><span>红包与转账</span></div>
            <div class="wallet-balances"><div>我的余额<strong id="wallet-self">—</strong></div><div>他的余额<strong id="wallet-partner">—</strong></div></div>
            <div id="wallet-login-note" class="wallet-box" hidden><p>登录后即可使用红包与转账。</p><button type="button" id="wallet-login">去登录</button></div>
            <div id="wallet-main" class="wallet-box" hidden>
                <strong>发给他</strong>
                <label>形式<select id="wallet-kind"><option value="redpacket">红包</option><option value="transfer">转账</option></select></label>
                <label>金额（元）<input id="wallet-amount" type="number" min="0.01" max="100000000" step="0.01" inputmode="decimal" placeholder="例如 52.00"></label>
                <div class="wallet-row"><button type="button" id="wallet-random">随机金额</button><button type="button" id="wallet-card-text">从字卡选文案</button></div>
                <label>转账文案<textarea id="wallet-caption" maxlength="280" placeholder="写点想说的话，也可以从字卡挑选"></textarea></label>
                <div class="wallet-row"><button type="button" id="wallet-send" class="wallet-primary">发给他</button></div>
            </div>
            <details class="wallet-box" id="wallet-controls" hidden style="margin-top:12px"><summary>调整余额</summary>
                <label>调整谁的余额<select id="wallet-side"><option value="self">我的</option><option value="partner">他的</option></select></label>
                <label>操作<select id="wallet-operation"><option value="plus">增加</option><option value="minus">减少</option></select></label>
                <label>金额（元）<input id="wallet-adjust-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="例如 100.00"></label>
                <div class="wallet-row"><button type="button" id="wallet-adjust">确认调整</button></div>
                <p class="wallet-note" id="wallet-adjust-log"></p>
            </details>
        </div>`;
        document.body.append(panel);
        byId('wallet-close').addEventListener('click', () => panel.classList.remove('open'));
        byId('wallet-login').addEventListener('click', () => window.MilkCloudSync?.open());
        byId('wallet-random').addEventListener('click', () => { byId('wallet-amount').value = randomAmount(); });
        byId('wallet-card-text').addEventListener('click', async () => {
            let pool = eligibleCards();
            if (!pool.length && client && user) {
                const { data } = await client.from('milk_moments_config').select('cards').eq('user_id', user.id).maybeSingle();
                if (Array.isArray(data?.cards)) pool = data.cards;
            }
            if (!pool.length) return toast('还没有可用字卡，请先添加或同步字卡', 'info');
            byId('wallet-caption').value = String(pool[Math.floor(Math.random()*pool.length)]).slice(0,280);
        });
        byId('wallet-send').addEventListener('click', send);
        byId('wallet-adjust').addEventListener('click', adjust);
        return panel;
    }
    async function session() {
        client = window.MilkCloudSync?.getClient();
        user = client ? await window.MilkCloudSync.currentUser() : null;
        if (!user) return false;
        if (Array.isArray(messages) && messages.some(m => m.type === 'wallet-transfer' && m.walletTransfer?.user_id !== user.id)) {
            messages = messages.filter(m => m.type !== 'wallet-transfer' || m.walletTransfer?.user_id === user.id);
            if (typeof renderMessages === 'function') renderMessages(true);
        }
        return true;
    }
    function check(result) {
        if (result.error) throw result.error;
        return result.data;
    }
    function mergeTransfers(transfers) {
        if (!Array.isArray(messages) || typeof renderMessages !== 'function') return;
        let changed = false;
        for (const t of transfers || []) {
            const messageId = `wallet-${t.id}`;
            const existing = messages.find(m => m.id === messageId);
            if (existing) {
                if (JSON.stringify(existing.walletTransfer) !== JSON.stringify(t)) { existing.walletTransfer = t; changed = true; }
            } else {
                messages.push({ id: messageId, type:'wallet-transfer', sender:t.sender==='self'?'user':'partner',
                    text:'', timestamp:new Date(t.created_at), walletTransfer:t, status:'read' });
                changed = true;
            }
        }
        if (changed) {
            messages.sort((a,b) => new Date(a.timestamp).getTime()-new Date(b.timestamp).getTime());
            const chat = document.getElementById('chat-container');
            const nearBottom = chat && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
            const oldTop = chat?.scrollTop || 0;
            renderMessages(!nearBottom);
            if (chat && !nearBottom) requestAnimationFrame(() => { chat.scrollTop = oldTop; });
            if (typeof throttledSaveData === 'function') throttledSaveData();
        }
    }
    async function refresh() {
        if (updating) return;
        updating = true;
        try {
            if (!await session()) return;
            account = check(await client.rpc('milk_wallet_snapshot'));
            const transfers = check(await client.from('milk_wallet_transfers').select('*').order('created_at',{ascending:false}).limit(200));
            mergeTransfers(transfers);
            if (panel?.classList.contains('open')) {
                byId('wallet-self').textContent = format(account.self_cents);
                byId('wallet-partner').textContent = format(account.partner_cents);
            }
        } finally { updating = false; }
    }
    async function open() {
        ensurePanel().classList.add('open');
        const loggedIn = await session().catch(() => false);
        byId('wallet-login-note').hidden = loggedIn;
        byId('wallet-main').hidden = !loggedIn;
        byId('wallet-controls').hidden = !loggedIn;
        if (!loggedIn) return;
        try { await refresh(); await loadAdjustments(); } catch (e) { toast(e.message || String(e),'error'); }
    }
    async function send() {
        const btn = byId('wallet-send');
        if (btn.disabled) return;
        try {
            if (!await session()) throw new Error('请先登录');
            const amount = cents(byId('wallet-amount').value);
            const kind = byId('wallet-kind').value;
            const caption = byId('wallet-caption').value.trim().slice(0,280);
            if (!window.confirm(`确定把 ${format(amount)} 的${kind==='redpacket'?'红包':'转账'}发给他吗？`)) return;
            btn.disabled = true;
            check(await client.rpc('milk_wallet_send',{p_amount_cents:amount,p_kind:kind,p_caption:caption}));
            byId('wallet-amount').value = ''; byId('wallet-caption').value = '';
            await refresh(); panel.classList.remove('open');
            toast('已发出','success');
        } catch (e) { toast(e.message || String(e),'error'); }
        finally { btn.disabled = false; }
    }
    async function claim(id) {
        try {
            if (!await session()) throw new Error('请先登录');
            const received = check(await client.rpc('milk_wallet_claim',{p_transfer_id:id}));
            await refresh();
            toast(received ? '领取成功，已经存入你的余额' : '已经领过这笔了','success');
        } catch (e) { toast(e.message || String(e),'error'); }
    }
    async function loadAdjustments() {
        if (!client || !user) return;
        const { data } = await client.from('milk_wallet_adjustments').select('side,delta_cents,created_at')
            .order('created_at',{ascending:false}).limit(5);
        if (byId('wallet-adjust-log')) byId('wallet-adjust-log').textContent = data?.length
            ? '最近调整：' + data.map(x => `${x.side==='self'?'我':'他'} ${x.delta_cents>0?'+':'−'}${format(Math.abs(x.delta_cents))}`).join(' · ')
            : '还没有手动调整记录';
    }
    async function adjust() {
        const btn = byId('wallet-adjust');
        if (btn.disabled) return;
        try {
            if (!await session()) throw new Error('请先登录');
            const amount = cents(byId('wallet-adjust-amount').value);
            const side = byId('wallet-side').value;
            const delta = byId('wallet-operation').value === 'minus' ? -amount : amount;
            if (!window.confirm(`确定将${side==='self'?'我的':'他的'}余额${delta>0?'增加':'减少'} ${format(amount)} 吗？`)) return;
            btn.disabled = true;
            check(await client.rpc('milk_wallet_adjust',{p_side:side,p_delta_cents:delta}));
            byId('wallet-adjust-amount').value = '';
            await refresh(); await loadAdjustments(); toast('余额已调整','success');
        } catch (e) { toast(e.message || String(e),'error'); }
        finally { btn.disabled = false; }
    }
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('wallet-open-btn')?.addEventListener('click',open);
        window.addEventListener('milk-app-ready',() => { refresh().catch(console.warn); });
        document.addEventListener('visibilitychange',() => {
            if (document.visibilityState==='visible') refresh().catch(console.warn);
        });
        setInterval(() => { if (document.visibilityState==='visible') refresh().catch(console.warn); },30000);
    });
    window.MilkWallet = { open, claim, refresh };
})();
