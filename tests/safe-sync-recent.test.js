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

function createContext(cloudRows) {
    const asyncValues = new Map();
    class Query {
        constructor(table) {
            this.table = table;
            this.orders = [];
            this.filters = [];
            this.max = null;
        }
        select() { return this; }
        order(column, options = {}) { this.orders.push([column, options.ascending !== false]); return this; }
        limit(value) { this.max = value; return this; }
        gte(column, value) { this.filters.push(row => row[column] >= value); return this; }
        lte(column, value) { this.filters.push(row => row[column] <= value); return this; }
        insert() { return Promise.resolve({ data: [], error: null }); }
        upsert(value) {
            if (!cloudRows.some(row => row.message_key === value.message_key)) {
                cloudRows.push({ ...value, created_at: new Date().toISOString() });
            }
            return Promise.resolve({ data: null, error: null });
        }
        run() {
            let rows = this.table === 'milk_safe_messages' ? cloudRows.slice() : [];
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

    const messages = [];
    const client = {
        from: table => new Query(table),
        storage: { from: () => ({
            createSignedUrls: async () => ({ data: [], error: null }),
            upload: async () => ({ data: null, error: null })
        }) }
    };
    const document = { hidden: false, addEventListener() {}, getElementById() { return null; } };
    const window = {
        addEventListener() {},
        MilkCloudSync: {
            getClient: () => client,
            currentUser: async () => ({ id: 'user-1' })
        }
    };
    const context = vm.createContext({
        console, window, document, messages, crypto: webcrypto, fetch,
        localStorage: createStore(),
        localforage: {
            getItem: async key => asyncValues.get(key) ?? null,
            setItem: async (key, value) => asyncValues.set(key, value)
        },
        saveData: async () => {}, renderMessages: () => {},
        setTimeout, clearTimeout, setInterval: () => 0, Date, Math, Promise, TextEncoder
    });
    vm.runInContext(fs.readFileSync('js/safe-sync.js', 'utf8'), context, { filename: 'js/safe-sync.js' });
    return { api: window.MilkSafeSync, messages };
}

function makeRow(index) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 0, 0, index)).toISOString();
    return {
        message_key: `key-${String(index).padStart(4, '0')}`,
        message: { id: index, text: index % 10 ? `消息 ${index}` : '相同文案', timestamp },
        media_path: null,
        created_at: timestamp
    };
}

(async () => {
    const cloudRows = Array.from({ length: 250 }, (_, index) => makeRow(index + 1));
    const { api, messages } = createContext(cloudRows);

    const initial = await api.mergeRemote();
    assert.equal(initial.initial, true);
    assert.equal(initial.added, 100);
    assert.equal(messages.length, 100);
    assert.equal(messages[0].syncId, 'key-0151');
    assert.equal(cloudRows.length, 250, 'recent bootstrap must not remove cloud history');
    assert.equal(api.hasOlder(), true, 'more cloud history should remain available');

    const repeat = await api.mergeRemote();
    assert.equal(repeat.added, 0);
    assert.equal(messages.length, 100, 're-entering must not duplicate messages');

    cloudRows.push(makeRow(251));
    const incremental = await api.mergeRemote();
    assert.equal(incremental.added, 1);
    assert.equal(messages.at(-1).syncId, 'key-0251');

    const older = await api.mergeOlder();
    assert.equal(older.added, 100);
    assert.equal(messages[0].syncId, 'key-0051');
    assert.equal(messages.length, 201);
    assert.equal(api.hasOlder(), true);

    const oldest = await api.mergeOlder();
    assert.equal(oldest.added, 50);
    assert.equal(oldest.more, false);
    assert.equal(api.hasOlder(), false, 'the loader should stop after cloud history is exhausted');
    assert.equal(messages[0].syncId, 'key-0001');

    messages.push({ ...messages[0] });
    const deduped = await api.mergeRemote();
    assert.equal(deduped.removed, 1, 'only an identical stable ID should be deduplicated');
    assert.equal(messages.filter(message => message.text === '相同文案').length, 25,
        'same text with different stable IDs must remain separate messages');

    console.log('safe-sync recent/cursor/older/dedup tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
