const fs = require('fs');
const assert = require('assert');

const moments = fs.readFileSync('js/moments.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20261002015325_wallet_balance_and_chat_sticker_source.sql', 'utf8');
const push = fs.readFileSync('supabase/functions/sleep-push/index.ts', 'utf8');

assert.match(migration, /random\(\) \* \(balance - 99\)/, '红包随机金额上限应取当前余额');
assert.match(migration, /520000/, '特殊金额应包含 ¥5200');
assert.match(migration, /where value <= balance/, '特殊金额必须先按余额过滤');
assert.match(migration, /milk_moments_sticker_auto_source/, '应限制自动评论表情来源');
assert.match(moments, /chat-partner-/, '聊天里的他的表情包应同步为 Moments 后台来源');
assert.match(moments, /disabledStickerItems/, '被屏蔽的聊天表情不应同步');
assert.match(moments, /!isSyncedPartnerSticker\(item\)/, '同步副本不应重复显示在私密图库');
assert.match(push, /30 \* 24 \* 60 \* 60_000/, '已导入的推送中转记录应保留 30 天后再清理');
assert.match(push, /not\('imported_at', 'is', null\)/, '清理不得删除尚未导入聊天的消息');

console.log('wallet and moments shared-library rules passed');
