(function () {
  'use strict';
  const TABLE = 'milk_questionnaires';
  const MAX_QUESTIONS = 10;
  const MAX_OPTIONS = 4;
  const PAGE_SIZE = 500;
  let db = null, user = null, screen = null, records = [], tab = 'create';
  let loadedStore = '', refreshing = null, dueTimer = null;
  let draft = freshDraft();

  const byId = id => document.getElementById(id);
  const nowIso = () => new Date().toISOString();
  const sessionId = () => String(typeof SESSION_ID !== 'undefined' && SESSION_ID ? SESSION_ID : 'default').slice(0, 120);
  // 问卷是整个关系共用的一本存档，不跟随本机会话 ID 分库，避免新设备生成不同会话 ID 后看不到旧问卷。
  const localKey = () => `${typeof APP_PREFIX !== 'undefined' ? APP_PREFIX : 'milk_'}questionnaires_v1`;
  const partnerName = () => (byId('partner-name')?.textContent || '他').trim() || '他';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  function notify(message, type = 'success') {
    if (typeof showNotification === 'function') showNotification(message, type, 4500);
    else window.alert(message);
  }
  function freshDraft() {
    return { title: '', questions: [{ text: '', options: ['', ''] }] };
  }
  function randomUnit() {
    if (crypto?.getRandomValues) {
      const value = new Uint32Array(1); crypto.getRandomValues(value); return value[0] / 4294967296;
    }
    return Math.random();
  }
  function responseDelayMinutes(count, random = randomUnit()) {
    // 按题量留出自然填写时间，但保证从发布到收到答案不超过 12 小时。
    const range = count <= 3 ? [60, 240] : count <= 6 ? [180, 480] : [360, 720];
    return range[0] + Math.floor(Math.max(0, Math.min(.999999, random)) * (range[1] - range[0] + 1));
  }
  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return hash >>> 0;
  }
  function deterministicIndex(recordId, questionIndex, optionCount) {
    return optionCount ? hashString(`${recordId}:${questionIndex}`) % optionCount : 0;
  }
  function cleanQuestions(source) {
    if (!Array.isArray(source) || source.length < 1 || source.length > MAX_QUESTIONS) throw new Error('请设置 1–10 个问题');
    return source.map((question, index) => {
      const text = String(question?.text || '').trim().slice(0, 160);
      const options = Array.isArray(question?.options)
        ? question.options.map(option => String(option || '').trim().slice(0, 100)).filter(Boolean)
        : [];
      if (!text) throw new Error(`请填写第 ${index + 1} 个问题`);
      if (options.length < 2 || options.length > MAX_OPTIONS) throw new Error(`第 ${index + 1} 题需要 2–4 个选项`);
      if (new Set(options).size !== options.length) throw new Error(`第 ${index + 1} 题有重复选项`);
      return { id: question.id || crypto.randomUUID(), text, options };
    });
  }
  function validateDraft(value) {
    const title = String(value?.title || '').trim().slice(0, 80);
    if (!title) throw new Error('请填写问卷标题');
    return { title, questions: cleanQuestions(value.questions) };
  }
  function normalizeRecord(record) {
    if (!record || !record.id) return null;
    return {
      ...record,
      title: String(record.title || '').slice(0, 80),
      questions: Array.isArray(record.questions) ? record.questions : [],
      answers: Array.isArray(record.answers) ? record.answers : null,
      status: record.status === 'completed' ? 'completed' : 'pending',
      _cloud: record._cloud === true,
      _dirty: record._dirty === true
    };
  }
  async function loadLocal() {
    const key = localKey();
    if (loadedStore === key) return;
    loadedStore = key;
    try {
      const saved = await localforage.getItem(key);
      records = Array.isArray(saved) ? saved.map(normalizeRecord).filter(Boolean) : [];
    } catch (error) {
      console.warn('[questionnaire] 本机存档读取失败:', error); records = [];
    }
  }
  async function saveLocal() {
    try { await localforage.setItem(localKey(), records); }
    catch (error) { console.warn('[questionnaire] 本机存档保存失败:', error); }
  }
  async function connect() {
    db = window.MilkCloudSync?.getClient?.() || null;
    user = db ? await window.MilkCloudSync.currentUser() : null;
    return !!(db && user);
  }
  function dbPayload(record) {
    return {
      id: record.id,
      user_id: user.id,
      session_id: sessionId(),
      title: record.title,
      questions: record.questions,
      answers: record.answers,
      status: record.status,
      sent_at: record.sent_at,
      answer_due_at: record.answer_due_at,
      answered_at: record.answered_at,
      updated_at: record.updated_at
    };
  }
  async function syncOne(record) {
    if (!db || !user || !record._dirty) return;
    if (!record._cloud) {
      const inserted = await db.from(TABLE).insert(dbPayload(record));
      if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
      record._cloud = true;
    }
    if (record.status === 'completed') {
      const updated = await db.from(TABLE).update({
        answers: record.answers,
        status: 'completed',
        answered_at: record.answered_at,
        updated_at: record.updated_at
      }).eq('id', record.id).eq('user_id', user.id);
      if (updated.error) throw updated.error;
    }
    record._dirty = false;
  }
  async function syncDirty() {
    for (const record of records.filter(item => item._dirty)) await syncOne(record);
    await saveLocal();
  }
  async function loadCloudRows() {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const result = await db.from(TABLE).select('*').eq('user_id', user.id)
        .order('sent_at', { ascending: false }).order('id', { ascending: false }).range(from, from + PAGE_SIZE - 1);
      if (result.error) throw result.error;
      rows.push(...(result.data || []));
      if (!result.data || result.data.length < PAGE_SIZE) break;
    }
    return rows;
  }
  function mergeCloudRows(rows) {
    const byRecordId = new Map(records.map(record => [record.id, record]));
    for (const raw of rows || []) {
      const cloud = normalizeRecord({ ...raw, _cloud: true, _dirty: false });
      const local = byRecordId.get(cloud.id);
      if (!local) { records.push(cloud); byRecordId.set(cloud.id, cloud); continue; }
      if (!local._dirty && String(cloud.updated_at || '') >= String(local.updated_at || '')) Object.assign(local, cloud);
      else local._cloud = true;
    }
  }
  function buildAnswers(record) {
    return record.questions.map((question, index) => {
      const optionIndex = deterministicIndex(record.id, index, question.options.length);
      return { question_id: question.id, option_index: optionIndex, text: question.options[optionIndex] };
    });
  }
  async function completeDue() {
    // 会话可能在定时器等待期间被切换；先换到当前会话的本机存档，避免串档。
    await loadLocal();
    const now = Date.now(); let changed = false;
    for (const record of records) {
      if (record.status !== 'pending' || new Date(record.answer_due_at).getTime() > now) continue;
      record.answers = buildAnswers(record);
      record.status = 'completed';
      record.answered_at = record.answer_due_at;
      record.updated_at = nowIso();
      record._dirty = true;
      changed = true;
    }
    if (changed) {
      await saveLocal();
      if (db && user) {
        try { await syncDirty(); } catch (error) { console.warn('[questionnaire] 作答同步稍后重试:', error); }
      }
      if (screen?.classList.contains('open') && tab === 'archive') renderArchive();
    }
    scheduleDueCheck();
  }
  function scheduleDueCheck() {
    clearTimeout(dueTimer); dueTimer = null;
    const next = records.filter(record => record.status === 'pending')
      .map(record => new Date(record.answer_due_at).getTime()).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (!next) return;
    dueTimer = setTimeout(() => completeDue().catch(console.warn), Math.max(300, Math.min(60000, next - Date.now())));
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await loadLocal();
      await completeDue();
      if (!await connect()) { renderCurrent(); return; }
      await syncDirty();
      mergeCloudRows(await loadCloudRows());
      await saveLocal();
      await completeDue();
      renderCurrent();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function formatStamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date).replace('日 ', '日 · ');
  }
  function ensureScreen() {
    if (screen) return screen;
    screen = document.createElement('section');
    screen.id = 'questionnaire-screen'; screen.className = 'questionnaire-screen';
    screen.setAttribute('aria-label', '我想了解你多一点');
    screen.innerHTML = `<div class="questionnaire-shell">
      <header class="questionnaire-top"><button type="button" id="questionnaire-close">← 返回</button><h2><i class="fas fa-question-circle"></i> 我想了解你多一点</h2></header>
      <nav class="questionnaire-tabs" aria-label="问卷页面">
        <button type="button" data-tab="create" class="active">新问卷</button>
        <button type="button" data-tab="archive">问卷存档</button>
      </nav>
      <main id="questionnaire-content"></main>
    </div>`;
    document.body.appendChild(screen);
    byId('questionnaire-close').addEventListener('click', () => screen.classList.remove('open'));
    screen.querySelector('.questionnaire-tabs').addEventListener('click', event => {
      const button = event.target.closest('[data-tab]'); if (!button) return;
      tab = button.dataset.tab; renderCurrent();
    });
    screen.addEventListener('input', event => {
      if (event.target.id === 'questionnaire-title') draft.title = event.target.value;
      if (event.target.matches('[data-question-text]')) draft.questions[Number(event.target.dataset.q)].text = event.target.value;
      if (event.target.matches('[data-option-text]')) draft.questions[Number(event.target.dataset.q)].options[Number(event.target.dataset.o)] = event.target.value;
    });
    screen.addEventListener('click', handleAction);
    return screen;
  }
  function renderTabs() {
    screen.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  }
  function questionHtml(question, index) {
    const options = question.options.map((option, optionIndex) => `<div class="questionnaire-option-row">
      <span>${String.fromCharCode(65 + optionIndex)}</span>
      <input data-option-text data-q="${index}" data-o="${optionIndex}" maxlength="100" value="${escapeHtml(option)}" placeholder="选项 ${optionIndex + 1}">
      ${question.options.length > 2 ? `<button type="button" data-action="remove-option" data-q="${index}" data-o="${optionIndex}" aria-label="删除这个选项">×</button>` : ''}
    </div>`).join('');
    return `<article class="questionnaire-question-card">
      <div class="questionnaire-question-head"><strong>问题 ${index + 1}</strong>${draft.questions.length > 1 ? `<button type="button" data-action="remove-question" data-q="${index}">删除</button>` : ''}</div>
      <input class="questionnaire-question-input" data-question-text data-q="${index}" maxlength="160" value="${escapeHtml(question.text)}" placeholder="写下你想问的问题">
      <div class="questionnaire-options">${options}</div>
      ${question.options.length < MAX_OPTIONS ? `<button type="button" class="questionnaire-link-btn" data-action="add-option" data-q="${index}">＋ 添加选项</button>` : ''}
    </article>`;
  }
  function renderCreate() {
    const content = byId('questionnaire-content');
    content.innerHTML = `<div class="questionnaire-form">
      <label class="questionnaire-title-label">问卷标题<input id="questionnaire-title" maxlength="80" value="${escapeHtml(draft.title)}" placeholder="例如：我们的睡前小问卷"></label>
      <div class="questionnaire-count"><span>${draft.questions.length} / ${MAX_QUESTIONS} 题</span><span>每题 2–${MAX_OPTIONS} 个选项</span></div>
      <div id="questionnaire-questions">${draft.questions.map(questionHtml).join('')}</div>
      <div class="questionnaire-form-actions">
        <button type="button" data-action="add-question" ${draft.questions.length >= MAX_QUESTIONS ? 'disabled' : ''}>＋ 添加问题</button>
        <button type="button" data-action="send" class="questionnaire-primary">发送给${escapeHtml(partnerName())}</button>
      </div>
    </div>`;
  }
  function archiveCard(record) {
    const stamp = record.status === 'completed' ? record.answered_at : record.sent_at;
    const answerByQuestion = new Map((record.answers || []).map(answer => [answer.question_id, answer]));
    const questions = record.questions.map((question, index) => {
      const answer = answerByQuestion.get(question.id);
      return `<div class="questionnaire-answer-item"><p>${index + 1}. ${escapeHtml(question.text)}</p>
        ${record.status === 'completed' ? `<strong>${escapeHtml(answer?.text || '—')}</strong>` : ''}</div>`;
    }).join('');
    const status = record.status === 'completed'
      ? `<span class="questionnaire-done">已填写</span>`
      : `<span class="questionnaire-waiting">预计 ${escapeHtml(formatStamp(record.answer_due_at))} 前后填好</span>`;
    return `<details class="questionnaire-archive-card" ${record.status === 'pending' ? 'open' : ''}>
      <summary><div><time>${escapeHtml(formatStamp(stamp))}</time><h3>${escapeHtml(record.title)}</h3></div>${status}</summary>
      <div class="questionnaire-answer-list">${questions}</div>
    </details>`;
  }
  function renderArchive() {
    const sorted = records.slice().sort((a, b) => new Date(b.answered_at || b.sent_at) - new Date(a.answered_at || a.sent_at));
    byId('questionnaire-content').innerHTML = `<div class="questionnaire-archive">
      <div class="questionnaire-archive-head"><span>按填写时间与标题存档</span><button type="button" data-action="refresh">刷新</button></div>
      ${sorted.length ? sorted.map(archiveCard).join('') : '<div class="questionnaire-empty"><i class="fas fa-question-circle"></i><p>还没有问卷存档</p></div>'}
    </div>`;
  }
  function renderCurrent() {
    if (!screen) return;
    renderTabs(); tab === 'archive' ? renderArchive() : renderCreate();
  }
  async function sendQuestionnaire(button) {
    const valid = validateDraft(draft);
    const sentAt = new Date();
    const delay = responseDelayMinutes(valid.questions.length);
    const dueAt = new Date(sentAt.getTime() + delay * 60000);
    const record = {
      id: crypto.randomUUID(), user_id: user?.id || null, session_id: sessionId(),
      title: valid.title, questions: valid.questions, answers: null, status: 'pending',
      sent_at: sentAt.toISOString(), answer_due_at: dueAt.toISOString(), answered_at: null,
      created_at: sentAt.toISOString(), updated_at: sentAt.toISOString(), _cloud: false, _dirty: true
    };
    button.disabled = true;
    try {
      records.push(record); await saveLocal();
      if (await connect()) await syncOne(record);
      await saveLocal(); draft = freshDraft(); tab = 'archive'; renderCurrent(); scheduleDueCheck();
      notify(`已经交给${partnerName()}，会在 12 小时内填好`, 'success');
    } catch (error) {
      console.warn('[questionnaire] 云端保存稍后重试:', error);
      await saveLocal(); draft = freshDraft(); tab = 'archive'; renderCurrent(); scheduleDueCheck();
      notify('问卷已保存在本机，联网后会继续同步', 'warning');
    } finally { button.disabled = false; }
  }
  async function handleAction(event) {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const q = Number(button.dataset.q), o = Number(button.dataset.o);
    if (button.dataset.action === 'add-question' && draft.questions.length < MAX_QUESTIONS) draft.questions.push({ text: '', options: ['', ''] });
    if (button.dataset.action === 'remove-question' && draft.questions.length > 1) draft.questions.splice(q, 1);
    if (button.dataset.action === 'add-option' && draft.questions[q]?.options.length < MAX_OPTIONS) draft.questions[q].options.push('');
    if (button.dataset.action === 'remove-option' && draft.questions[q]?.options.length > 2) draft.questions[q].options.splice(o, 1);
    if (button.dataset.action === 'send') {
      try { await sendQuestionnaire(button); } catch (error) { notify(error.message || String(error), 'error'); }
      return;
    }
    if (button.dataset.action === 'refresh') {
      button.disabled = true;
      try { await refresh(); notify('问卷存档已刷新'); } catch (error) { notify('刷新失败：' + (error.message || error), 'error'); }
      finally { button.disabled = false; }
      return;
    }
    renderCreate();
  }
  async function open() {
    ensureScreen().classList.add('open');
    try { await loadLocal(); await completeDue(); renderCurrent(); await refresh(); }
    catch (error) { console.warn('[questionnaire] 打开失败:', error); renderCurrent(); notify('云端存档暂时没有刷新，本机内容仍保留', 'warning'); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    byId('questionnaire-open')?.addEventListener('click', open);
    window.addEventListener('milk-app-ready', () => refresh().catch(console.warn));
    window.addEventListener('online', () => refresh().catch(console.warn));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh().catch(console.warn);
    });
  });
  window.MilkQuestionnaires = {
    open, refresh,
    _test: { responseDelayMinutes, deterministicIndex, validateDraft }
  };
})();
