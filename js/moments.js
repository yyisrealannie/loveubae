(function () {
  'use strict';
  const bucket = 'milk-moments';
  const TARGET_IMAGE_BYTES = 2 * 1024 * 1024;
  const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
  const MAX_GIF_BYTES = 8 * 1024 * 1024;
  const MAX_BATCH_UPLOAD = 30;
  const QUERY_PAGE_SIZE = 500;
  const GALLERY_PAGE_SIZE = 60;
  const FEED_PAGE_SIZE = 15;
  const PICKER_LIMIT = 60;
  const STICKER_PICKER_LIMIT = 24;
  let db, user, config, posts = [], comments = [], media = [], tab = 'feed', screen;
  let libraryReady = false, librarySyncTimer = null, librarySyncPromise = null;
  let galleryFilter = 'all', gallerySort = 'newest', galleryVisibleCount = GALLERY_PAGE_SIZE;
  let feedVisibleCount = FEED_PAGE_SIZE;
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
  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  function mediaName(item, fallbackIndex = 0) {
    const saved = String(item?.display_name || '').trim();
    if (saved) return saved;
    const kind = item?.kind === 'sticker' ? '表情包' : '照片';
    const date = item?.created_at ? new Date(item.created_at).toLocaleDateString() : '';
    return `${kind}${fallbackIndex ? ` ${fallbackIndex}` : ''}${date ? ` · ${date}` : ''}`;
  }
  function albumName(item) {
    return String(item?.album_name || '未分类').trim().slice(0, 40) || '未分类';
  }
  function normalizeAlbum(value) {
    return String(value || '').trim().slice(0, 40) || '未分类';
  }
  function notify(text, type = 'success') {
    if (typeof window.showNotification === 'function') window.showNotification(text, type, 5000);
  }
  function canvasBlob(canvas, mime, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, mime, quality));
  }
  async function prepareImage(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
    if (!allowed.includes(file.type)) throw new Error('请选择 JPG、PNG、WebP、HEIC 或 GIF 图片');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('原图超过 30 MB，请先在相册里缩小后再试');
    if (file.type === 'image/gif') {
      if (file.size > MAX_GIF_BYTES) throw new Error('动图超过 8 MB；为了保留动画，请先压缩 GIF 后再上传');
      return { blob: file, mime: file.type, extension: 'gif', compressed: false, originalSize: file.size };
    }
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    const needsConversion = file.type === 'image/heic' || file.type === 'image/heif';
    if (file.size <= TARGET_IMAGE_BYTES && !needsConversion) {
      return { blob: file, mime: file.type, extension, compressed: false, originalSize: file.size };
    }

    const sourceUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('这张图片无法读取，请换一张或先另存为 JPG'));
        img.src = sourceUrl;
      });
      let width = image.naturalWidth;
      let height = image.naturalHeight;
      const longest = Math.max(width, height);
      if (longest > 2560) {
        const scale = 2560 / longest;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('当前浏览器无法压缩图片');
      let result = null;
      let quality = 0.88;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        canvas.width = width;
        canvas.height = height;
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        result = await canvasBlob(canvas, 'image/webp', quality);
        if (!result) result = await canvasBlob(canvas, 'image/jpeg', quality);
        if (result && result.size <= TARGET_IMAGE_BYTES) break;
        if (quality > 0.58) quality -= 0.1;
        else {
          width = Math.max(1, Math.round(width * 0.82));
          height = Math.max(1, Math.round(height * 0.82));
        }
      }
      if (!result || result.size > TARGET_IMAGE_BYTES) throw new Error('自动压缩后仍超过 2 MB，请换一张尺寸更小的图片');
      const outputMime = ['image/jpeg', 'image/png', 'image/webp'].includes(result.type) ? result.type : 'image/webp';
      const outputExtension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[outputMime];
      return { blob: result, mime: outputMime, extension: outputExtension, compressed: true, originalSize: file.size };
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }
  async function uploadMediaFile(file, kind, allowAuto = false, silent = false, album = '未分类') {
    const prepared = await prepareImage(file);
    const objectPath = `${user.id}/${crypto.randomUUID()}.${prepared.extension}`;
    await checked(db.storage.from(bucket).upload(objectPath, prepared.blob, { contentType: prepared.mime, upsert: false }));
    try {
      const originalName = String(file.name || '').replace(/\.[^.]+$/, '').trim().slice(0, 80) || null;
      const item = await checked(db.from('milk_moments_media').insert({
        user_id: user.id,
        object_path: objectPath,
        kind,
        allow_auto: allowAuto,
        display_name: originalName,
        album_name: normalizeAlbum(album)
      }).select().single());
      if (!silent) {
        if (prepared.compressed) notify(`已自动压缩：${formatBytes(prepared.originalSize)} → ${formatBytes(prepared.blob.size)}`);
        else notify('图片已上传');
      }
      return item;
    } catch (error) {
      await db.storage.from(bucket).remove([objectPath]);
      throw error;
    }
  }
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
    if (!db || !user) return 0;
    if (librarySyncPromise) return librarySyncPromise;
    librarySyncPromise = (async () => {
    const cards = myCards();
    const partnerName = (document.getElementById('partner-name')?.textContent || '他').trim().slice(0, 80) || '他';
    const values = { cards, partner_name: partnerName, updated_at: new Date().toISOString() };
    if (!config) {
      config = await checked(db.from('milk_moments_config').insert({ user_id: user.id, ...values }).select().single());
    } else if (JSON.stringify(config.cards) !== JSON.stringify(cards) || config.partner_name !== partnerName) {
      config = await checked(db.from('milk_moments_config').update(values).eq('user_id', user.id).select().single());
    }
      return cards.length;
    })();
    try { return await librarySyncPromise; }
    finally { librarySyncPromise = null; }
  }
  function scheduleLibrarySync() {
    if (!libraryReady || !db || !user) return;
    clearTimeout(librarySyncTimer);
    librarySyncTimer = setTimeout(() => syncCards().catch(error => console.warn('[moments] 字卡库自动更新失败:', error)), 1200);
  }
  async function loadRows(table, configure) {
    const rows = [];
    for (let from = 0; ; from += QUERY_PAGE_SIZE) {
      let query = db.from(table).select('*').eq('user_id', user.id);
      query = configure(query).range(from, from + QUERY_PAGE_SIZE - 1);
      const page = await checked(query);
      rows.push(...page);
      if (page.length < QUERY_PAGE_SIZE) break;
    }
    return rows;
  }
  async function refresh() {
    [config, media, posts, comments] = await Promise.all([
      checked(db.from('milk_moments_config').select('*').eq('user_id', user.id).maybeSingle()),
      loadRows('milk_moments_media', query => query.order('created_at', { ascending: false }).order('id', { ascending: false })),
      loadRows('milk_moments_posts', query => query.order('created_at', { ascending: false }).order('id', { ascending: false })),
      loadRows('milk_moments_comments', query => query.order('created_at', { ascending: true }).order('id', { ascending: true })),
    ]);
    const validPaths = new Set(media.map(item => item.object_path));
    for (const path of urlCache.keys()) if (!validPaths.has(path)) urlCache.delete(path);
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
  async function appendImage(target, mediaId, extraClass = '') {
    if (!mediaId) return;
    try {
      const link = await imageFor(mediaId);
      if (!link) return;
      const img = node('img', 'moments-media' + (media.find(x => x.id === mediaId)?.kind === 'sticker' ? ' moments-sticker' : '') + (extraClass ? ` ${extraClass}` : ''));
      img.src = link; img.alt = '私密图片'; img.loading = 'lazy'; target.append(img);
    } catch (_) { target.append(note('图片暂时无法载入，请稍后刷新')); }
  }
  function photoPicker(onChoose) {
    const picker = node('div', 'moments-photo-picker');
    picker.dataset.value = '';
    Object.defineProperty(picker, 'value', { get: () => picker.dataset.value || '' });
    const choose = (choice, value) => {
      picker.querySelectorAll('.moments-photo-choice').forEach(item => item.classList.remove('selected'));
      choice.classList.add('selected');
      picker.dataset.value = value;
      if (typeof onChoose === 'function') onChoose(value);
    };
    const empty = button('无图', () => choose(empty, ''));
    empty.className = 'moments-photo-choice selected moments-photo-none';
    picker.append(empty);
    media.filter(item => item.kind === 'photo').slice(0, PICKER_LIMIT).forEach((item, index) => {
      const choice = button('', () => choose(choice, item.id));
      choice.className = 'moments-photo-choice';
      choice.title = mediaName(item, index + 1);
      const caption = node('span', '', mediaName(item, index + 1));
      imageFor(item.id).then(url => {
        if (!url || !choice.isConnected) return;
        const img = node('img'); img.src = url; img.alt = mediaName(item, index + 1);
        choice.prepend(img);
      }).catch(() => choice.remove());
      choice.append(caption);
      picker.append(choice);
    });
    picker.reset = () => choose(empty, '');
    return picker;
  }
  function stickerPicker() {
    const picker = node('div', 'moments-sticker-picker');
    picker.dataset.value = '';
    Object.defineProperty(picker, 'value', { get: () => picker.dataset.value || '' });
    const choose = (choice, value) => {
      picker.querySelectorAll('.moments-sticker-choice').forEach(item => item.classList.remove('selected'));
      choice.classList.add('selected');
      picker.dataset.value = value;
    };
    const empty = button('无', () => choose(empty, ''));
    empty.className = 'moments-sticker-choice selected moments-sticker-none';
    empty.title = '不使用表情包';
    picker.append(empty);

    media.filter(item => item.kind === 'sticker').slice(0, STICKER_PICKER_LIMIT).forEach(item => {
      const choice = button('', () => choose(choice, item.id));
      choice.className = 'moments-sticker-choice';
      choice.title = '私密图库表情';
      imageFor(item.id).then(url => {
        if (!url || !choice.isConnected) return;
        const img = node('img'); img.src = url; img.alt = '表情包'; choice.append(img);
      }).catch(() => choice.remove());
      picker.append(choice);
    });

    const chatStickers = typeof myStickerLibrary !== 'undefined' && Array.isArray(myStickerLibrary) ? myStickerLibrary : [];
    chatStickers.slice(0, STICKER_PICKER_LIMIT).forEach((source, index) => {
      const choice = button('', () => choose(choice, `chat:${index}`));
      choice.className = 'moments-sticker-choice';
      choice.title = `我的表情 ${index + 1}`;
      const img = node('img'); img.src = source; img.alt = `我的表情 ${index + 1}`; choice.append(img);
      picker.append(choice);
    });
    return picker;
  }
  async function resolveSticker(selection) {
    if (!selection || !selection.startsWith('chat:')) return selection || null;
    const index = Number(selection.slice(5));
    const chatStickers = typeof myStickerLibrary !== 'undefined' && Array.isArray(myStickerLibrary) ? myStickerLibrary : [];
    const source = chatStickers[index];
    if (!source) throw new Error('这张表情已不存在，请重新选择');

    const blob = await fetch(source).then(response => {
      if (!response.ok) throw new Error('读取表情失败');
      return response.blob();
    });
    if (blob.size > 8 * 1024 * 1024) throw new Error('这张表情超过 8 MB，无法发送');
    const mime = ['image/jpeg','image/png','image/webp','image/gif'].includes(blob.type) ? blob.type : 'image/png';
    const extension = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' }[mime];
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const objectPath = `${user.id}/chat-self-${hash.slice(0, 32)}.${extension}`;

    let item = media.find(entry => entry.object_path === objectPath);
    if (!item) {
      item = await checked(db.from('milk_moments_media').select('*').eq('user_id', user.id).eq('object_path', objectPath).maybeSingle());
    }
    if (!item) {
      await checked(db.storage.from(bucket).upload(objectPath, blob, { contentType: mime, upsert: false }));
      try {
        item = await checked(db.from('milk_moments_media').insert({ user_id: user.id, object_path: objectPath, kind: 'sticker', allow_auto: false, display_name: `我的表情 ${index + 1}`, album_name: '聊天表情' }).select().single());
      } catch (error) {
        await db.storage.from(bucket).remove([objectPath]);
        throw error;
      }
    }
    if (!media.some(entry => entry.id === item.id)) media.unshift(item);
    return item.id;
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
    const compose = node('div', 'moments-card');
    const text = field('textarea', '记下今天想说的话…');
    const directInput = node('input'); directInput.type = 'file'; directInput.accept = 'image/*'; directInput.hidden = true;
    const directPreview = node('div', 'moments-direct-preview');
    let directFile = null, directUrl = null;
    const clearDirect = () => {
      directFile = null;
      directInput.value = '';
      if (directUrl) URL.revokeObjectURL(directUrl);
      directUrl = null;
      directPreview.replaceChildren();
    };
    const photo = photoPicker(value => { if (value) clearDirect(); });
    const chooseDirect = button('从手机相册选择', () => directInput.click());
    directInput.addEventListener('change', () => {
      const selected = directInput.files?.[0];
      if (!selected) return;
      clearDirect();
      directFile = selected;
      directUrl = URL.createObjectURL(selected);
      photo.reset();
      const img = node('img'); img.src = directUrl; img.alt = '准备发表的图片';
      const info = node('span', '', `${selected.name || '已选图片'} · ${formatBytes(selected.size)}`);
      directPreview.append(img, info, button('移除', clearDirect));
    });
    const publishButton = button('发表', async () => {
      if (!text.value.trim() && !photo.value && !directFile) return alertError('写点文字或者选择一张图片再发表');
      publishButton.disabled = true;
      publishButton.textContent = directFile ? '正在处理图片…' : '正在发表…';
      try {
        let mediaId = photo.value;
        if (directFile) {
          const uploaded = await uploadMediaFile(directFile, 'photo', true, false, '动态配图');
          media.unshift(uploaded);
          mediaId = uploaded.id;
        }
        await publish(text.value, mediaId);
        clearDirect();
      } catch (e) {
        alertError(e);
        publishButton.disabled = false;
        publishButton.textContent = '发表';
      }
    }, true);
    compose.append(
      node('div', 'moments-person', '写一条动态'),
      text,
      node('div', 'moments-meta', '直接选择手机照片'),
      row(chooseDirect, directInput),
      directPreview,
      node('div', 'moments-meta', '或者从私密图库选择'),
      photo,
      row(publishButton)
    );
    root.append(compose);
    if (!posts.length) root.append(note('这里还没有动态。可以先写下你们的第一个瞬间。'));
    const commentsByPost = new Map();
    comments.forEach(comment => {
      const thread = commentsByPost.get(comment.post_id) || [];
      thread.push(comment);
      commentsByPost.set(comment.post_id, thread);
    });
    for (const post of posts.slice(0, feedVisibleCount)) {
      const card = node('article', 'moments-card');
      const own = post.author === 'self';
      const name = own ? (document.getElementById('my-name')?.textContent || '我').trim() : config?.partner_name || '他';
      const person = node('div', 'moments-person'); person.append(node('span', 'moments-dot', own ? '我' : '♥'), node('span', '', name));
      const postMedia = node('div', 'moments-post-media-wrap');
      card.append(person, node('time', 'moments-meta', new Date(post.created_at).toLocaleString()), node('div', 'moments-body', post.body), postMedia);
      appendImage(postMedia, post.media_id, 'moments-post-media');
      const actions = row(button(post.liked ? '♥ 已喜欢' : '♡ 喜欢', async () => {
        try { await checked(db.from('milk_moments_posts').update({ liked: !post.liked }).eq('id', post.id)); post.liked = !post.liked; renderShell(); } catch (e) { alertError(e); }
      }), button('删除动态', async () => {
        if (!window.confirm('删除这条动态？它下面的评论会一起删除，图片仍会保留在私密图库。')) return;
        try {
          await checked(db.from('milk_moments_posts').delete().eq('id', post.id).eq('user_id', user.id));
          await refresh(); renderShell();
        } catch (e) { alertError(e); }
      }));
      actions.classList.add('moments-actions');
      card.append(actions);
      const thread = commentsByPost.get(post.id) || [];
      const commentSection = node('section', 'moments-comments');
      for (const comment of thread) {
        const entry = node('div', 'moments-comment');
        entry.append(node('strong', '', comment.author === 'self' ? '我：' : `${config?.partner_name || '他'}：`), node('span', '', comment.body));
        const commentMedia = node('div', 'moments-comment-media-wrap');
        entry.append(commentMedia);
        appendImage(commentMedia, comment.media_id, 'moments-comment-media');
        if (comment.author === 'self') entry.append(button('删除', async () => {
          if (!window.confirm('确定删除这条评论？')) return;
          try { await checked(db.from('milk_moments_comments').delete().eq('id', comment.id)); await refresh(); renderShell(); } catch (e) { alertError(e); }
        }));
        commentSection.append(entry);
      }
      const commentText = field('input', '写评论或回复…'); commentText.maxLength = 1000;
      const sticker = stickerPicker();
      const send = async () => {
        if (!commentText.value.trim() && !sticker.value) return;
        try {
          const mediaId = await resolveSticker(sticker.value);
          await checked(db.from('milk_moments_comments').insert({ user_id: user.id, post_id: post.id, author: 'self', body: commentText.value.trim(), media_id: mediaId }));
          await refresh(); renderShell();
        } catch (e) { alertError(e); }
      };
      commentText.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
      commentSection.append(row(commentText, sticker, button('发送', send, true)));
      if (thread.filter(x => x.author === 'partner').length >= 10) commentSection.append(note('这条动态已达到最多 10 次自动回复，你还可以继续留言。'));
      card.append(commentSection);
      root.append(card);
    }
    if (posts.length > feedVisibleCount) {
      root.append(row(button(`再看 ${Math.min(FEED_PAGE_SIZE, posts.length - feedVisibleCount)} 条旧动态`, () => {
        feedVisibleCount += FEED_PAGE_SIZE;
        renderShell();
      })));
    }
  }
  function renderGallery(root) {
    const upload = node('input'); upload.type = 'file'; upload.accept = 'image/*'; upload.multiple = true;
    const type = field('select'); type.append(new Option('照片', 'photo'), new Option('表情包', 'sticker'));
    const allow = node('input'); allow.type = 'checkbox'; allow.checked = true;
    const albums = [...new Set(media.map(albumName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const albumListId = 'moments-album-list';
    const albumList = node('datalist'); albumList.id = albumListId;
    albums.forEach(value => albumList.append(new Option(value, value)));
    const uploadAlbum = field('input', '相册分类，如：旅行');
    uploadAlbum.value = '未分类'; uploadAlbum.maxLength = 40;
    uploadAlbum.setAttribute('list', albumListId);
    const uploadButton = button('批量上传', async () => {
      const files = Array.from(upload.files || []);
      if (!files.length) return alertError('请先选择图片');
      if (files.length > MAX_BATCH_UPLOAD) return alertError(`一次最多选择 ${MAX_BATCH_UPLOAD} 张图片`);
      uploadButton.disabled = true;
      let success = 0;
      const failures = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        uploadButton.textContent = `正在上传 ${index + 1}/${files.length}`;
        try {
          await uploadMediaFile(file, type.value, allow.checked, true, uploadAlbum.value);
          success += 1;
        } catch (error) {
          failures.push(`${file.name || `第 ${index + 1} 张`}：${errorText(error)}`);
        }
      }
      try { await refresh(); renderShell(); }
      catch (error) {
        uploadButton.disabled = false;
        uploadButton.textContent = `上传 ${files.length} 张`;
        return alertError(error);
      }
      if (failures.length) {
        window.alert(`已成功上传 ${success} 张，失败 ${failures.length} 张。\n${failures.slice(0, 3).join('\n')}${failures.length > 3 ? '\n…' : ''}`);
      } else {
        notify(`已上传 ${success} 张图片`);
      }
    }, true);
    upload.addEventListener('change', () => {
      const count = upload.files?.length || 0;
      uploadButton.textContent = count ? `上传 ${count} 张` : '批量上传';
    });
    const uploadBox = node('div', 'moments-card moments-gallery-upload');
    const allowLabel = node('label', 'moments-check-label', '默认允许他使用'); allowLabel.prepend(allow);
    uploadBox.append(node('div', 'moments-person', '添加到小相册'), upload, row(type, uploadAlbum), allowLabel, uploadButton, albumList);
    root.append(uploadBox);

    const filter = field('select');
    filter.append(new Option('全部相册', 'all'));
    albums.forEach(value => filter.append(new Option(value, value)));
    filter.value = albums.includes(galleryFilter) ? galleryFilter : 'all';
    const sort = field('select');
    sort.append(new Option('最新上传', 'newest'), new Option('最早上传', 'oldest'), new Option('按名称', 'name'));
    sort.value = gallerySort;
    const rerenderGallery = () => {
      galleryFilter = filter.value;
      gallerySort = sort.value;
      galleryVisibleCount = GALLERY_PAGE_SIZE;
      renderShell();
    };
    filter.addEventListener('change', rerenderGallery);
    sort.addEventListener('change', rerenderGallery);
    root.append(row(filter, sort));

    let shown = media.filter(item => galleryFilter === 'all' || albumName(item) === galleryFilter);
    shown.sort((a, b) => {
      if (gallerySort === 'oldest') return new Date(a.created_at) - new Date(b.created_at);
      if (gallerySort === 'name') return mediaName(a).localeCompare(mediaName(b), 'zh-CN');
      return new Date(b.created_at) - new Date(a.created_at);
    });
    if (!shown.length) root.append(note(galleryFilter === 'all' ? '相册还是空的。' : '这个分类里还没有图片。'));
    const gallery = node('div', 'moments-gallery'); root.append(gallery);
    for (const [index, item] of shown.slice(0, galleryVisibleCount).entries()) {
      const card = node('article', 'moments-gallery-item');
      const thumb = button('', () => card.classList.toggle('expanded'));
      thumb.className = 'moments-gallery-thumb';
      thumb.setAttribute('aria-label', `打开 ${mediaName(item, index + 1)} 的设置`);
      appendImage(thumb, item.id);
      const caption = node('div', 'moments-gallery-caption');
      caption.append(node('strong', '', mediaName(item, index + 1)), node('span', '', albumName(item)));
      const details = node('div', 'moments-gallery-details');
      const name = field('input', '给这张图片起个名字');
      name.value = mediaName(item, index + 1);
      name.maxLength = 80;
      const itemAlbum = field('input', '相册分类');
      itemAlbum.value = albumName(item); itemAlbum.maxLength = 40;
      itemAlbum.setAttribute('list', albumListId);
      const saveName = button('保存', async () => {
        const value = name.value.trim().slice(0, 80);
        if (!value) return alertError('图片名称不能为空');
        try {
          const nextAlbum = normalizeAlbum(itemAlbum.value);
          await checked(db.from('milk_moments_media').update({ display_name: value, album_name: nextAlbum }).eq('id', item.id).eq('user_id', user.id));
          item.display_name = value;
          item.album_name = nextAlbum;
          saveName.textContent = '已保存';
          caption.querySelector('strong').textContent = value;
          caption.querySelector('span').textContent = nextAlbum;
          setTimeout(() => { if (saveName.isConnected) saveName.textContent = '保存'; }, 1200);
        } catch (e) { alertError(e); }
      });
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = item.allow_auto;
      checkbox.addEventListener('change', async () => {
        try { await checked(db.from('milk_moments_media').update({ allow_auto: checkbox.checked }).eq('id', item.id).eq('user_id', user.id)); item.allow_auto = checkbox.checked; }
        catch (e) { checkbox.checked = !checkbox.checked; alertError(e); }
      });
      const label = node('label', '', `${item.kind === 'sticker' ? '表情包' : '照片'} · 允许他使用`); label.prepend(checkbox);
      details.append(name, itemAlbum, row(saveName, button('删除', async () => {
        if (!window.confirm('删除这张私密图片？动态中的图片也将不再显示。')) return;
        try {
          await checked(db.from('milk_moments_media').delete().eq('id', item.id));
          await checked(db.storage.from(bucket).remove([item.object_path]));
          urlCache.delete(item.object_path); await refresh(); renderShell();
        } catch (e) { alertError(e); }
      })), label);
      card.append(thumb, caption, details); gallery.append(card);
    }
    if (shown.length > galleryVisibleCount) root.append(row(button(`再显示 ${Math.min(GALLERY_PAGE_SIZE, shown.length - galleryVisibleCount)} 张`, () => {
      galleryVisibleCount += GALLERY_PAGE_SIZE;
      renderShell();
    })));
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
      libraryReady = true;
      renderShell();
    } catch (e) { body().replaceChildren(note('打开失败：' + errorText(e))); }
  }
  document.addEventListener('DOMContentLoaded', () => document.getElementById('moments-open')?.addEventListener('click', open));
  window.MilkMoments = { open, scheduleLibrarySync };
})();
