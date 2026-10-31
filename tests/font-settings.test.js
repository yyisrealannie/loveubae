const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
    const properties = new Map();
    const faces = new Set();
    const pending = [];
    const context = vm.createContext({
        console: { error() {}, warn() {} }, setTimeout, clearTimeout, window: {},
        settings: { customFontUrl: 'old.woff2', messageFontFamily: 'OldFont', fontSize: 16 },
        showNotification() {},
        document: {
            documentElement: { style: { setProperty: (k, v) => properties.set(k, v) } },
            fonts: faces
        },
        FontFace: class {
            constructor(family) { this.family = family; }
            load() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); }
        }
    });
    vm.runInContext(fs.readFileSync('js/utils.js', 'utf8'), context);
    context.showNotification = () => {};
    return { context, properties, pending };
}

test('reset survives UI reapplication and keeps the chosen size', async () => {
    const { context, properties } = setup();
    assert.equal(await context.applyCustomFont(''), true);
    assert.match(context.settings.messageFontFamily, /Songti SC/);
    assert.equal(context.settings.customFontUrl, '');
    assert.equal(context.settings.fontSize, 16);
    assert.equal(properties.get('--font-family'), context.resolveFontStack(context.settings.messageFontFamily));
    assert.match(context.resolveFontStack("'Noto Serif SC', serif"), /Songti SC/);
    assert.equal(context.resolveFontStack('system-ui, -apple-system, sans-serif'), 'system-ui, -apple-system, sans-serif');
});

test('failed font load does not replace the saved font', async () => {
    const { context, pending } = setup();
    const loading = context.applyCustomFont('broken.woff2');
    pending[0].reject(new Error('offline'));
    assert.equal(await loading, false);
    assert.equal(context.settings.customFontUrl, 'old.woff2');
    assert.equal(context.settings.messageFontFamily, 'OldFont');
});

test('a late download cannot undo a newer reset', async () => {
    const { context, pending } = setup();
    const loading = context.applyCustomFont('slow.woff2');
    await context.applyCustomFont('');
    pending[0].resolve();
    assert.equal(await loading, false);
    assert.equal(context.settings.customFontUrl, '');
    assert.match(context.settings.messageFontFamily, /Songti SC/);
});
