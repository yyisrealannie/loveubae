(function () {
  'use strict';
  const bucket = 'milk-moments';
  let db, user, config, posts = [], comments = [], media = [], tab = 'feed', screen;
  const urlCache = new Map();
  const $ = (selector, root = screen) => root.querySelector(selector);
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function button(text, onClick, primary = false) {
    const el = node('button', 'moments-btn' + (primary ? ' moments-primary' : ''), text);
    el.type = 'button'; el.addEventListener('click', onClick); return el;
  }
  function note(text) { const el = node('p', 'moments-note', text); return el; }
  function row(...elements) { const el = node('div', 'moments-row'); el.append(...elements); return el; }
  function field(tag, placeholder) {
    const el = node(tag, 'moments-field'); el.placeholder = placeholder;
    if (tag === 'textarea') el.rows = 3;
    return el;
  }
  function errorText(error) { return error && error.message ? error.message : String(error); }
  function alertError(error) { window.alert(`爱你多一天：${errorText(error)}`); }
  function ensure() {
    if (screen) return;
    screen = node('section', 'moments-screen'); screen.id = 'moments-screen';
    screen.setAttribute('aria-label', '爱你多一天');
    screen.innerHTML = '<div class="moments-shell"><div class="moments-top"><h2>爱你多一天</h2></div><div id="moments-content"></div></div>';
    $('.moments-top').prepend(button('← 返回', () => screen.classList.remove('open')));
    document.body.append(screen);
  }
  const body = () => $('#moments-content');
  function checked(promise) { return promise.then(result => { if (result.error) throw result.error; return result.data; }); }
  function myCards() {
    const disabled = (() => { try { return new Set(JSON.parse(localStorage.getItem('disabledReplyItems') || '[]')); } catch (_) { return new Set(); } })();
    const disabledGroups = new Set();
    (window.customReplyGroups || []).forEach(group => {
      if (group.disabled) (group.items || []).forEach(item => disabledGroups.add(item));
    });
    const source = typeof customReplies !== 'undefined' ? customReplies : window._customReplies;
    return Array.isArray(source) ? [...new Set(source.filter(x => typeof x === 'string' && !disabled.has(x) && !disabledGroups.has(x)).map(x => x.trim().slice(0, 1000)).filter(Boolean))].slice(0, 500) : [];
  }
  async function syncCards() {
    const cards = myCards();
    const partnerName = (document.getElementById('partner-name')?.textContent || '他').trim().slice(0, 80) || '他';
    const values = { cards, partner_name: partnerName, updated_at: new Date().toISOString() };
    if (!config) {
      config = await checked(db.from('milk_moments_config').insert({ user_id: user.id, ...values }).select().single());
    } else if (JSON.stringify(config.cards) !== JSON.stringify(cards) || config.partner_name !== partnerName) {
      config = await checked(db.from('milk_moments_config').update(values).eq('user_id', user.id).select().single());
    }
    return cards.length;
  }
  async function refresh() {
    [config, media, posts] = await Promise.all([
      checked(db.from('milk_moments_config').select('*').eq('user_id', user.id).maybeSingle()),
      checked(db.from('milk_moments_media').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(150)),
      checked(db.from('milk_moments_posts').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100)),
    ]);
    if (posts.length) comments = await checked(db.from('milk_moments_comments').select('*').in('post_id', posts.map(p => p.id)).order('created_at').limit(1000));
    else comments = [];
  }
  async function imageFor(mediaId) {
    if (!mediaId) return null;
    const item = media.find(m => m.id === mediaId);
    if (!item) return null;
    const cached = urlCache.get(item.object_path);
    if (cached && cached.until > Date.now()) return cached.url;
    const data = await checked(db.storage.from(bucket).createSignedUrl(item.object_path, 3600));
    urlCache.set(item.object_path, { url: data.signedUrl, until: Date.now() + 55 * 60000 });
    return data.signedUrl;
  }
  async function appendImage(target, mediaId) {
    if (!mediaId) return;
    try {
      const link = await imageFor(mediaId);
      if (!link) return;
      const img = node('img', 'moments-media' + (media.find(x => x.id === mediaId)?.kind === 'sticker' ? ' moments-sticker' : ''));
      img.src = link; img.alt = '私密图片'; img.loading = 'lazy'; target.append(img);
    } catch (_) { target.append(note('图片暂时无法载入，请稍后刷新')); }
  }
  function selector(kind) {
    const select = field('select');
    select.append(new Option(kind === 'photo' ? '不配图片' : '不用表情包', ''));
    media.filter(x => x.kind === kind).forEach(x => select.append(new Option(`${kind === 'photo' ? '照片' : '表情包'} · ${new Date(x.created_at).toLocaleDateString()}`, x.id)));
    return select;
  }
  function renderShell() {
    const root = body(); root.replaceChildren();
    root.append(row(button('动态', () => { tab = 'feed'; renderShell(); }), button('私密图库', () => { tab = 'gallery'; renderShell(); }), button('刷新', async () => {
      try { await refresh(); renderShell(); } catch (e) { alertError(e); }
    })));
    const tabButtons = root.querySelectorAll('.moments-row button');
    tabButtons[tab === 'gallery' ? 1 : 0].classList.add('active');
    if (tab === 'gallery') renderGallery(root);
    else renderFeed(root);
  }
  async function publish(text, photoId) {
    if (!text.trim() && !photoId) return alertError('写点文字或者选择一张图片再发表');
    await checked(db.from('milk_moments_posts').insert({ user_id: user.id, author: 'self', body: text.trim().slice(0, 2000), media_id: photoId || null }));
    await refresh(); renderShell();
  }
  function renderFeed(root) {
    if (!config?.cards?.length) root.append(note('还没有同步可用字卡。他的动态和评论会从你的字卡库挑选；先在聊天页添加字卡，然后点“同步字卡”。你仍然可以先发自己的动态。'));
    root.append(row(button('同步字卡', async () => {
      try {
        if (!myCards().length && config?.cards?.length && !window.confirm('这台设备暂无字卡。继续会清空云端动态的字卡池，确定吗？')) return;
        const count = await syncCards(); window.alert(`已同步 ${count} 条可用字卡；不上传整站聊天备份。`); renderShell();
      } catch (e) { alertError(e); }
    }), note('他约每周发 1 条、偶尔 2 条；你发帖后，他会在约 2–9 分钟内评论。关闭网页也会继续。')));
    const compose = node('div', 'moments-card');
    const text = field('textarea', '记下今天想说的话…'); const photo = selector('photo');
    compose.append(node('div', 'moments-person', '写一条动态'), text, row(photo, button('发表', async () => {
      try { await publish(text.value, photo.value); } catch (e) { alertError(e); }
    }, true))); root.append(compose);
    if (!posts.length) root.append(note('这里还没有动态。可以先写下你们的第一个瞬间。'));
    for (const post of posts) {
      const card = node('article', 'moments-card');
      const own = post.author === 'self';
      const name = own ? (document.getElementById('my-name')?.textContent || '我').trim() : config?.partner_name || '他';
      const person = node('div', 'moments-person'); person.append(node('span', 'moments-dot', own ? '我' : '♥'), node('span', '', name));
      card.append(person, node('time', 'moments-meta', new Date(post.created_at).toLocaleString()), node('div', 'moments-body', post.body));
      appendImage(card, post.media_id);
      card.append(row(button(post.liked ? '♥ 已喜欢' : '♡ 喜欢', async () => {
        try { await checked(db.from('milk_moments_posts').update({ liked: !post.liked }).eq('id', post.id)); post.liked = !post.liked; renderShell(); } catch (e) { alertError(e); }
      })));
      const thread = comments.filter(x => x.post_id === post.id);
      for (const comment of thread) {
        const entry = node('div', 'moments-comment');
        entry.append(node('strong', '', comment.author === 'self' ? '我：' : `${config?.partner_name || '他'}：`), node('span', '', comment.body));
        appendImage(entry, comment.media_id);
        if (comment.author === 'self') entry.append(button('删除', async () => {
          if (!window.confirm('确定删除这条评论？')) return;
          try { await checked(db.from('milk_moments_comments').delete().eq('id', comment.id)); await refresh(); renderShell(); } catch (e) { alertError(e); }
        }));
        card.append(entry);
      }
      const commentText = field('input', '写评论或回复…'); commentText.maxLength = 1000;
      const sticker = selector('sticker');
      const send = async () => {
        if (!commentText.value.trim() && !sticker.value) return;
        try {
          await checked(db.from('milk_moments_comments').insert({ user_id: user.id, post_id: post.id, author: 'self', body: commentText.value.trim(), media_id: sticker.value || null }));
          await refresh(); renderShell();
        } catch (e) { alertError(e); }
      };
      commentText.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
      card.append(row(commentText, sticker, button('发送', send, true)));
      if (thread.filter(x => x.author === 'partner').length >= 10) card.append(note('这条动态已达到最多 10 次自动回复，你还可以继续留言。'));
      root.append(card);
    }
  }
  function renderGallery(root) {
    root.append(note('图片只存进你的 Supabase 私密图库。只有勾选“允许他发动态/回复时使用”的图片或表情包，才会被自动挑选。最多 8 MB / 张。'));
    const upload = node('input'); upload.type = 'file'; upload.accept = 'image/jpeg,image/png,image/webp,image/gif';
    const type = field('select'); type.append(new Option('照片', 'photo'), new Option('表情包', 'sticker'));
    const allow = node('input'); allow.type = 'checkbox';
    root.append(row(upload, type, node('label', '', '允许他自动使用'), allow, button('上传图片', async () => {
      const file = upload.files?.[0];
      if (!file) return alertError('先选择一张图片');
      if (file.size > 8 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) return alertError('请选择不超过 8 MB 的 JPG/PNG/WebP/GIF 图片');
      const extension = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' }[file.type];
      const objectPath = `${user.id}/${crypto.randomUUID()}.${extension}`;
      try {
        await checked(db.storage.from(bucket).upload(objectPath, file, { contentType: file.type, upsert: false }));
        try { await checked(db.from('milk_moments_media').insert({ user_id: user.id, object_path: objectPath, kind: type.value, allow_auto: allow.checked })); }
        catch (e) { await db.storage.from(bucket).remove([objectPath]); throw e; }
        await refresh(); renderShell();
      } catch (e) { alertError(e); }
    }, true)));
    const gallery = node('div', 'moments-gallery'); root.append(gallery);
    for (const item of media) {
      const card = node('div', 'moments-gallery-item moments-card');
      appendImage(card, item.id);
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = item.allow_auto;
      checkbox.addEventListener('change', async () => {
        try { await checked(db.from('milk_moments_media').update({ allow_auto: checkbox.checked }).eq('id', item.id)); item.allow_auto = checkbox.checked; }
        catch (e) { checkbox.checked = !checkbox.checked; alertError(e); }
      });
      const label = node('label', '', `${item.kind === 'sticker' ? '表情包' : '照片'} · 允许他使用`); label.prepend(checkbox);
      card.append(label, button('删除', async () => {
        if (!window.confirm('删除这张私密图片？动态中的图片也将不再显示。')) return;
        try {
          await checked(db.from('milk_moments_media').delete().eq('id', item.id));
          await checked(db.storage.from(bucket).remove([item.object_path]));
          urlCache.delete(item.object_path); await refresh(); renderShell();
        } catch (e) { alertError(e); }
      })); gallery.append(card);
    }
  }
  async function open() {
    ensure(); screen.classList.add('open'); body().replaceChildren(note('正在加载…'));
    try {
      db = window.MilkCloudSync?.getClient(); user = await window.MilkCloudSync?.currentUser();
      if (!db || !user) {
        body().replaceChildren(note('先用你自己的 Supabase 邮箱账号登录，才能安全保存动态和图库。'));
        body().append(button('去登录', () => window.MilkCloudSync.open(), true)); return;
      }
      await refresh();
      // 新设备没有本地字卡时保留云端池，不会因为打开页面而清空它。
      if (myCards().length || !config) await syncCards();
      renderShell();
    } catch (e) { body().replaceChildren(note('打开失败：' + errorText(e))); }
  }
  document.addEventListener('DOMContentLoaded', () => document.getElementById('moments-open')?.addEventListener('click', open));
  window.MilkMoments = { open };
})();
