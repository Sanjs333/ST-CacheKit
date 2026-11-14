import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installWorldInfoStability } from '../src/worldinfo-stability.js';

function createEventSource() {
    const listeners = new Map();
    return {
        on(event, listener) {
            const entries = listeners.get(event) ?? [];
            entries.push(listener); listeners.set(event, entries);
        },
        removeListener(event, listener) {
            listeners.set(event, (listeners.get(event) ?? []).filter(value => value !== listener));
        },
        async emit(event, ...args) {
            for (const listener of listeners.get(event) ?? []) await listener(...args);
        },
    };
}

async function captureWorldInfoRequest() {
    const eventSource = createEventSource();
    const context = {
        mainApi: 'openai', extensionSettings: {}, saveSettingsDebounced() {},
        getCurrentChatId: () => 'fixture-chat', getChatCompletionModel: () => 'fixture-model',
        chatCompletionSettings: { chat_completion_source: 'makersuite', google_model: 'fixture-model' },
        eventSource, eventTypes: { WORLDINFO_SCAN_DONE: 'scan', GENERATION_STARTED: 'start' },
    };
    let ordinal = 0;
    const feature = installWorldInfoStability({ context, receiptAttempts: 1,
        idFactory: () => 'fixture-token-' + ++ordinal,
        digest: text => createHash('sha256').update(text).digest('hex') });
    const request = { chat_completion_source: 'makersuite', model: 'fixture-model', messages: [] };
    await eventSource.emit('start', 'normal', {}, false);
    await eventSource.emit('scan', { isFinal: true, isDryRun: false, activated: {
        entries: new Map([
            ['first', { world: 'fixture-book', uid: 1, order: 100, position: 0, content: 'First world-info entry.' }],
            ['second', { world: 'fixture-book', uid: 2, order: 100, position: 0, content: 'Second world-info entry.' }],
        ]),
    } });
    assert.equal(feature.snapshot().lastScan.valid, true);
    assert.equal(feature.snapshot().lastScan.groups, 1);
    const token = feature.captureRequest(request, { chatId: 'fixture-chat' });
    assert.equal(typeof token, 'string');
    const plan = feature.requestPlan(token, request);
    assert.equal(plan.groups.length, 1);
    const receipt = { version: 1, token, epoch: 'fixture-server-epoch', sequence: 1,
        groups: plan.groups.map(group => ({ id: group.id, status: 'confirmed', items: group.items.map(item => item.id) })) };
    return { feature, token, receipt };
}

for (const { name, usageLookup, expected } of [
    { name: 'new backend advertises ID lookup', usageLookup: true, expected: { ids: ['fixture-usage'] } },
    { name: 'old backend omits ID lookup capability', usageLookup: undefined, expected: { latest: 12 } },
    { name: 'backend explicitly disables ID lookup', usageLookup: false, expected: { latest: 12 } },
    { name: 'non-boolean capability does not enable ID lookup', usageLookup: 'true', expected: { latest: 12 } },
]) {
    test(`world-info receipt query remains bounded when ${name}`, async t => {
        const { feature, token, receipt } = await captureWorldInfoRequest();
        t.after(() => feature.destroy());
        const calls = [];
        const confirmed = await feature.confirmRequest(token, { responseOk: true,
            prepared: { usageId: 'fixture-usage', worldInfoOrderReceipts: true,
                ...(usageLookup === undefined ? {} : { usageLookup }) },
            serverClient: { async readUsage(chatId, options) {
                calls.push({ chatId, options });
                return { ok: true, records: [{ id: 'fixture-usage', chatId: 'fixture-chat',
                    googleRequests: [{ worldInfoOrder: receipt }] }] };
            } },
        });
        assert.equal(confirmed, true);
        assert.deepEqual(calls, [{ chatId: 'fixture-chat', options: { includeRequestPreviews: true, ...expected } }]);
        assert.equal(feature.snapshot().lastConfirmation.status, 'confirmed');
        assert.equal(feature.snapshot().lastConfirmation.confirmedGroups, 1);
        assert.equal(feature.snapshot().pending, 0);
    });
}

test('failed generations do not read world-info receipt usage', async t => {
    const { feature, token } = await captureWorldInfoRequest();
    t.after(() => feature.destroy());
    const confirmed = await feature.confirmRequest(token, { responseOk: false,
        prepared: { usageId: 'fixture-usage', worldInfoOrderReceipts: true, usageLookup: true },
        serverClient: { readUsage() { assert.fail('Failed requests must not query usage'); } },
    });
    assert.equal(confirmed, false);
    assert.equal(feature.snapshot().pending, 0);
});
