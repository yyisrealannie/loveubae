const assert = require('node:assert/strict');
const fs = require('node:fs');

const envelope = fs.readFileSync('js/features/envelope.js', 'utf8');
const questionnaire = fs.readFileSync('js/questionnaire.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(envelope, /PROACTIVE_ENVELOPE_WEEKLY_LIMIT = 4/,
  '拼贴信的每周上限应提高到 4 封');
assert.match(envelope, /PROACTIVE_ENVELOPE_CHANCE = 0\.12/,
  '拼贴信触发概率应从 8% 提高到 12%');
assert.match(envelope, /outgoing\.replyToId = sourceLetter\.id/,
  '回信应与原拼贴信关联');
assert.match(envelope, /sourceLetter\.userRepliedAt = Date\.now\(\)/,
  '原拼贴信应记录已回信状态');
assert.match(html, /id="env-view-reply-btn"/,
  '拼贴信详情应提供回信按钮');

assert.match(questionnaire, /id="questionnaire-create-notice"/,
  '问卷发送提醒应显示在创建页');
assert.match(questionnaire, /catch \(error\) \{ showCreateNotice\(error\.message \|\| String\(error\), 'error'\); \}/,
  '问卷校验失败应使用页内提醒');
assert.match(questionnaire, /createNotice = \{ message: '问卷已保存在本机，联网后会继续同步', type: 'warning' \}/,
  '离线保存提醒也应留在问卷创建页');
assert.match(questionnaire, /问卷未能保存或发送，请检查浏览器存储与网络后重试/,
  '本机和云端都失败时应给出明确页内提醒');
assert.match(serviceWorker, /loveubae-v47/,
  '本次前端更新应刷新 PWA 缓存');

console.log('envelope frequency/reply and questionnaire inline-notice tests passed');
