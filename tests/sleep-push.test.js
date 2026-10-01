const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const values = new Map();
values.set('sleepPushActiveUntil', String(Date.now() + 60 * 60 * 1000));
const localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); }
};

const elements = Object.fromEntries([
  'sleep-push-status', 'sleep-push-enable', 'sleep-push-test', 'sleep-push-disable',
  'sleep-push-hours', 'sleep-push-hours-value', 'sleep-push-frequency',
  'sleep-push-interval', 'sleep-push-interval-value'
].map(id => [id, { id, textContent: '', value: '', disabled: false }]));

let currentSubscription = null;
const registration = {
  pushManager: {
    async getSubscription() { return currentSubscription; }
  }
};
const navigator = {
  standalone: true,
  userAgent: 'iPhone OS 26_2 like Mac OS X',
  platform: 'iPhone',
  maxTouchPoints: 5,
  serviceWorker: {
    ready: Promise.resolve(registration),
    addEventListener() {}
  }
};
const Notification = { permission: 'granted' };
const window = {
  navigator,
  Notification,
  PushManager: function PushManager() {},
  matchMedia() { return { matches: true }; },
  addEventListener() {}
};
const document = {
  getElementById(id) { return elements[id] || null; },
  addEventListener() {}
};
const context = vm.createContext({
  window, document, navigator, Notification, localStorage,
  console, Date, Math, Promise, Uint8Array, setTimeout, clearTimeout,
  settings: { autoSendInterval: 5, partnerName: '宝宝小深' }
});
vm.runInContext(fs.readFileSync('js/sleep-push.js', 'utf8'), context, { filename: 'js/sleep-push.js' });

(async () => {
  await window.SleepPush.refreshStatus();
  assert.equal(elements['sleep-push-enable'].textContent, '重新开启');
  assert.equal(elements['sleep-push-test'].disabled, true);
  assert.match(elements['sleep-push-status'].textContent, /订阅已失效/);

  currentSubscription = { endpoint: 'https://push.example/device' };
  await window.SleepPush.refreshStatus();
  assert.equal(elements['sleep-push-enable'].textContent, '续10小时');
  assert.equal(elements['sleep-push-test'].disabled, false);
  assert.match(elements['sleep-push-status'].textContent, /已开启/);

  console.log('sleep-push subscription status tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
