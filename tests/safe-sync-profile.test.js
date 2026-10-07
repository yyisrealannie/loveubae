const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function createStore() {
    const values = new Map();
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value))
    };
}

function createContext(profileRows, overrides = {}) {
    const messageRows = [];
    const asyncValues = new Map();
    const mediaBlobs = overrides.mediaBlobs || new Map();
    class Query {
        constructor(table) { this.table = table; this.orders = []; this.max = null; this.filters = []; }
        select() { return this; }
        order(column, options = {}) { this.orders.push([column, options.ascending !== false]); return this; }
        limit(value) { this.max = value; return this; }
        gte(column, value) { this.filters.push(row => row[column] >= value); return this; }
        lte(column, value) { this.filters.push(row => row[column] <= value); return this; }
        insert(value) {
            if (this.table === 'milk_safe_profiles') profileRows.push({ ...value, created_at: '2026-10-07T03:00:00Z' });
            return Promise.resolve({ data: [], error: null });
        }
        upsert(value) {
            if (this.table === 'milk_safe_messages' && !messageRows.some(row => row.message_key === value.message_key)) {
                messageRows.push({ ...value, created_at: new Date().toISOString() });
            }
            return Promise.resolve({ data: null, error: null });
        }
        run() {
            let rows = (this.table === 'milk_safe_profiles' ? profileRows : messageRows).slice();
            for (const filter of this.filters) rows = rows.filter(filter);
            rows.sort((left, right) => {
                for (const [column, ascending] of this.orders) {
                    const result = String(left[column]).localeCompare(String(right[column]));
                    if (result) return ascending ? result : -result;
                }
                return 0;
            });
            if (this.max != null) rows = rows.slice(0, this.max);
            return { data: rows, error: null };
        }
        then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    }

    const client = {
        from: table => new Query(table),
        storage: { from: () => ({
            createSignedUrls: async () => ({ data: [], error: null }),
            upload: async () => ({ data: null, error: null }),
            download: async path => mediaBlobs.has(path)
                ? ({ data: mediaBlobs.get(path), error: null })
                : ({ data: null, error: new Error(`missing media: ${path}`) })
        }) }
    };
    const document = {
        hidden: false,
        body: { classList: { toggle() {} } },
        addEventListener() {},
        getElementById() { return null; }
    };
    const window = {
        addEventListener() {},
        customReplyGroups: [], customPokeGroups: [], customStatusGroups: [],
        MilkCloudSync: {
            getClient: () => client,
            currentUser: async () => ({ id: 'user-1' })
        }
    };
    const localStorage = createStore();
    if (overrides.priorAck) localStorage.setItem('milkSafeProfileAck:user-1', overrides.priorAck);
    const context = vm.createContext({
        console, window, document, crypto: webcrypto, fetch, Blob, btoa,
        localStorage,
        localforage: {
            getItem: async key => asyncValues.get(key) ?? null,
            setItem: async (key, value) => asyncValues.set(key, value)
        },
        messages: overrides.messages || [{ id: 1, text: '欢迎回来', timestamp: new Date('2026-10-07T00:00:00Z') }],
        customReplies: overrides.customReplies || [],
        customEmojis: [], customPokes: ['默认拍拍'], myPokes: [], customStatuses: ['在线'],
        stickerLibrary: overrides.stickerLibrary || [], myStickerLibrary: overrides.myStickerLibrary || [],
        customMottos: [], customIntros: [], anniversaries: [], showPartnerNameInChat: false,
        settings: { partnerName: '梦角', myName: '我', replyEnabled: true, showPartnerNameInChat: false },
        saveData: async () => {}, updateUI: () => {}, renderMessages: () => {},
        setTimeout, clearTimeout, setInterval: () => 0, Date, Math, Promise, TextEncoder
    });
    vm.runInContext(fs.readFileSync('js/safe-sync.js', 'utf8'), context, { filename: 'js/safe-sync.js' });
    return { api: window.MilkSafeSync, context, profileRows, asyncValues };
}

(async () => {
    const legacyRows = [
        {
            created_at: '2026-10-07T02:00:00Z', device_id: 'new-device',
            profile: { customReplies: [], settings: { partnerName: '梦角', myName: '我' } }
        },
        {
            created_at: '2026-10-07T01:00:00Z', device_id: 'old-device',
            profile: {
                customReplies: ['抱抱', '想你了'], customReplyGroups: [{ name: '亲密', items: ['抱抱'] }],
                myPokes: ['捏捏手'], settings: { partnerName: '宝宝小深', myName: '歪歪', replyEnabled: true }
            }
        }
    ];
    const legacy = createContext(legacyRows, { priorAck: 'old-empty-profile-marker' });
    await legacy.api.start();
    assert.deepEqual(Array.from(legacy.context.customReplies), ['抱抱', '想你了'],
        'a local welcome message must not block card restoration');
    assert.equal(legacy.context.settings.partnerName, '宝宝小深');
    assert.equal(legacy.context.settings.myName, '歪歪');
    assert.deepEqual(Array.from(legacy.context.myPokes), ['捏捏手']);
    const upgraded = legacyRows.find(row => row.profile?._sync?.version === 3);
    assert.ok(upgraded, 'a recovered legacy profile should be upgraded to a versioned snapshot');
    assert.deepEqual(Array.from(upgraded.profile.customReplies), ['抱抱', '想你了'],
        'the new device must never upload an empty profile before recovery');

    const versionedRows = [{
        created_at: '2026-10-07T04:00:00Z', device_id: 'main-device',
        profile: {
            _sync: { version: 2, updatedAt: '2026-10-07T04:00:00Z' },
            customReplies: [], customReplyGroups: [], customPokes: [], customStatuses: [],
            customEmojis: [], myPokes: [], customPokeGroups: [], customStatusGroups: [],
            customMottos: [], customIntros: [], anniversaries: [], disabledReplyItems: [],
            settings: { partnerName: '新昵称', myName: '我自己', replyEnabled: true, showPartnerNameInChat: false }
        }
    }];
    const versioned = createContext(versionedRows, { customReplies: ['旧字卡'] });
    await versioned.api.start();
    assert.deepEqual(Array.from(versioned.context.customReplies), [],
        'an intentional empty card library in a v2 snapshot must remain empty');
    assert.equal(versioned.context.settings.partnerName, '新昵称');
    assert.equal(versionedRows.length, 2, 'a restored v2 snapshot should be upgraded to v3 media-aware format');
    assert.equal(versionedRows.at(-1).profile._sync.version, 3);

    const mediaRows = [{
        created_at: '2026-10-07T04:30:00Z', device_id: 'media-device',
        profile: {
            _sync: { version: 3, updatedAt: '2026-10-07T04:30:00Z' },
            customReplies: ['带图字卡'], customReplyGroups: [], disabledReplyItems: [],
            customEmojis: [], customPokes: [], myPokes: [], customStatuses: [],
            customPokeGroups: [], customStatusGroups: [], customMottos: [], customIntros: [], anniversaries: [],
            settings: { partnerName: '有头像的昵称', myName: '我', replyEnabled: true },
            media: {
                partnerAvatar: null, myAvatar: null, partnerAvatarFrame: null, myAvatarFrame: null,
                stickerLibrary: [{ path: 'user-1/profile/partner.png', mime: 'image/png' }],
                myStickerLibrary: [{ path: 'user-1/profile/mine.png', mime: 'image/png' }]
            }
        }
    }];
    const mediaBlobs = new Map([
        ['user-1/profile/partner.png', new Blob(['partner-sticker'], { type: 'image/png' })],
        ['user-1/profile/mine.png', new Blob(['my-sticker'], { type: 'image/png' })]
    ]);
    const media = createContext(mediaRows, { mediaBlobs });
    await media.api.start();
    assert.equal(media.context.stickerLibrary.length, 1);
    assert.match(media.context.stickerLibrary[0], /^data:image\/png;base64,/);
    assert.equal(media.context.myStickerLibrary.length, 1);
    assert.match(media.context.myStickerLibrary[0], /^data:image\/png;base64,/);

    const establishedRows = [{
        created_at: '2026-10-07T05:00:00Z', device_id: 'other-device',
        profile: {
            _sync: { version: 2, updatedAt: '2026-10-07T05:00:00Z' },
            customReplies: ['云端字卡'], settings: { partnerName: '云端昵称', myName: '云端的我' }
        }
    }];
    const established = createContext(establishedRows, {
        priorAck: 'existing-device-marker', customReplies: ['本机离线新增字卡']
    });
    established.context.settings.partnerName = '本机昵称';
    await established.api.start();
    assert.deepEqual(Array.from(established.context.customReplies), ['本机离线新增字卡'],
        'an established device with local custom content must not be overwritten during upgrade');
    assert.equal(established.context.settings.partnerName, '本机昵称');

    const localSticker = 'data:image/png;base64,eA==';
    const stickerOnlyRows = [{
        created_at: '2026-10-07T06:00:00Z', device_id: 'empty-device',
        profile: {
            _sync: { version: 3, updatedAt: '2026-10-07T06:00:00Z' }, customReplies: [],
            settings: { partnerName: '梦角', myName: '我' },
            media: { partnerAvatar: null, myAvatar: null, partnerAvatarFrame: null, myAvatarFrame: null,
                stickerLibrary: [], myStickerLibrary: [] }
        }
    }];
    const stickerOnly = createContext(stickerOnlyRows, {
        priorAck: 'old-media-marker', stickerLibrary: [localSticker]
    });
    await stickerOnly.api.start();
    assert.deepEqual(Array.from(stickerOnly.context.stickerLibrary), [localSticker],
        'an empty cloud snapshot must not erase an established local sticker library');
    assert.equal(stickerOnlyRows.at(-1).profile.media.stickerLibrary.length, 1,
        'the preserved local sticker should be uploaded in the next v3 snapshot');

    console.log('safe-sync profile/card/nickname restoration tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
