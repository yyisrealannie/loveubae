const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const window = {};
const document = { addEventListener() {}, getElementById() { return null; } };
const context = vm.createContext({ window, document, crypto: webcrypto, console, Intl, Date, Math, Uint32Array });
vm.runInContext(fs.readFileSync('js/questionnaire.js', 'utf8'), context, { filename: 'js/questionnaire.js' });

const test = window.MilkQuestionnaires._test;
assert.equal(test.responseDelayMinutes(1, 0), 60);
assert.equal(test.responseDelayMinutes(3, 0.999999), 240);
assert.equal(test.responseDelayMinutes(4, 0), 180);
assert.equal(test.responseDelayMinutes(6, 0.999999), 480);
assert.equal(test.responseDelayMinutes(7, 0), 360);
assert.equal(test.responseDelayMinutes(10, 0.999999), 720);

const valid = test.validateDraft({
    title: ' 睡前小问卷 ',
    questions: [{ text: '今天开心吗？', options: ['开心', '很开心'] }]
});
assert.equal(valid.title, '睡前小问卷');
assert.equal(valid.questions.length, 1);
assert.equal(valid.questions[0].options.length, 2);

assert.throws(() => test.validateDraft({ title: '', questions: [] }), /标题/);
assert.throws(() => test.validateDraft({
    title: '重复选项', questions: [{ text: '选一个', options: ['A', 'A'] }]
}), /重复选项/);
assert.throws(() => test.validateDraft({
    title: '问题太多', questions: Array.from({ length: 11 }, () => ({ text: '问题', options: ['A', 'B'] }))
}), /1–10/);

const first = test.deterministicIndex('fixed-id', 2, 4);
assert.equal(first, test.deterministicIndex('fixed-id', 2, 4));
assert.ok(first >= 0 && first < 4);

console.log('questionnaire validation/timing/deterministic-answer tests passed');
