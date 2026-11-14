import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerClient } from '../src/server-client.js';
import { createMessageCosts } from '../src/message-costs.js';

const response = data => ({ ok: true, json: async () => data });

test('targeted usage reads batch IDs, deduplicate them and request previews explicitly', async () => {
    const calls = [], ids = Array.from({ length: 205 }, (_, index) => 'usage-' + index);
    const client = createServerClient({ localize: null, fetchImpl: async url => {
        const query = new URL(url, 'http://fixture').searchParams;
        calls.push(query);
        return response({ ok: true, lookup: true, records: query.get('ids').split(',').map(id => ({ id })) });
    } });
    const result = await client.readUsage('chat', { ids: [...ids, ids[0]], includeRequestPreviews: true });
    assert.deepEqual(result.records.map(record => record.id), ids);
    assert.deepEqual(calls.map(query => query.get('ids').split(',').length), [100, 100, 5]);
    assert.ok(calls.every(query => query.get('includeRequestPreviews') === '1' && !query.has('latest')));
    await client.readUsage('chat', { ids: [] });
    assert.equal(calls.length, 3);
    await assert.rejects(client.readUsage('chat', { ids: ['bad,id'] }), TypeError);
});

test('old backends fall back to one complete paginated ledger scan for all requested IDs', async () => {
    const calls = [];
    const client = createServerClient({ localize: null, fetchImpl: async url => {
        const query = new URL(url, 'http://fixture').searchParams; calls.push(query);
        return response(query.has('cursor')
            ? { ok: true, records: [{ id: 'usage-204' }, { id: 'irrelevant' }] }
            : { ok: true, records: [{ id: 'usage-0' }], nextCursor: 'second', truncated: true });
    } });
    const result = await client.readUsage('chat', { ids: Array.from({ length: 205 }, (_, index) => 'usage-' + index) });
    assert.deepEqual(result.records.map(record => record.id), ['usage-0', 'usage-204']);
    assert.equal(result.truncated, false);
    assert.equal(calls.length, 2);
});

test('full conversation totals still read every page and reject repeated cursors', async () => {
    const client = createServerClient({ localize: null, fetchImpl: async url => {
        const query = new URL(url, 'http://fixture').searchParams;
        assert.equal(query.has('ids'), false);
        return response(query.has('cursor') ? { ok: true, records: [{ id: 'b' }] }
            : { ok: true, records: [{ id: 'a' }], nextCursor: 'next', truncated: true });
    } });
    assert.deepEqual((await client.readUsage('chat')).records.map(record => record.id), ['a', 'b']);
    const broken = createServerClient({ localize: null, fetchImpl: async () => response({ ok: true, records: [], nextCursor: 'repeat' }) });
    await assert.rejects(broken.readUsage('chat'), error => error.code === 'INVALID_USAGE_RESPONSE');
});

test('message cost refresh asks for only its unresolved request IDs', async () => {
    const requests = [{ id: 'finished', chatId: 'chat', record: { status: 'complete' } },
        { id: 'waiting', chatId: 'chat', record: { status: 'pending' } }];
    const context = { chat: [{ extra: { vertex_paygo_cost: { version: 1, requests } } }], eventTypes: {} };
    const calls = [];
    const costs = createMessageCosts({ getContext: () => context, getChatId: () => 'chat', documentRef: null,
        serverClient: { readUsage: async (chatId, options) => {
            calls.push({ chatId, ...options });
            return { ok: true, records: [{ id: 'waiting', chatId, status: 'complete', usage: { promptTokenCount: 100 } }] };
        } } });
    try {
        await costs.refresh();
        assert.deepEqual(calls, [{ chatId: 'chat', ids: ['waiting'] }]);
        assert.equal(requests[1].record.status, 'complete');
        await costs.refresh(); assert.equal(calls.length, 1);
    } finally { costs.destroy(); }
});
