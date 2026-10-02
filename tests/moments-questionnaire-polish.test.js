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
assert.match(migration, /date_trunc\('day', local_time\).*random\(\) \* interval '12 hours'/,
  '安静时段到期的动态应随机安排到白天窗口');
assert.doesNotMatch(migration, /extract\(hour from local_time\) < 10 or/,
  '动态不应继续统一卡在 10:00 发布');

console.log('moments gallery, schedule, and questionnaire archive tests passed');
