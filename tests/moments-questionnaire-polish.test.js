const fs = require('node:fs');
const assert = require('node:assert/strict');

const moments = fs.readFileSync('js/moments.js', 'utf8');
const questionnaire = fs.readFileSync('js/questionnaire.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20261002122015_randomize_moments_daytime.sql', 'utf8');

assert.match(moments, /galleryMedia = media\.filter\(item => item\.kind === 'photo'\)/,
  '发帖相册必须只展示照片');
assert.doesNotMatch(moments, /choice\.title = '私密图库表情'/,
  '评论选择器不应继续展示独立 Moments 图库表情');
assert.match(questionnaire, /questionnaire-archive-options/,
  '问卷存档应展示完整选项');
assert.match(questionnaire, /optionIndex === selectedIndex/,
  '问卷存档应标记被选择的选项');
assert.match(migration, /if cfg\.next_post_at > tick_now then continue; end if;/,
  '动态应按已经生成的随机时间判断是否到期');
assert.doesNotMatch(migration, /extract\(hour from local_time\)/,
  '动态发布时间不应再受固定小时窗口限制');

console.log('moments gallery, schedule, and questionnaire archive tests passed');
