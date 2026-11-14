import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTraceBudget } from '../src/trace-budget.js';
import { createPromptInspectorController } from '../src/prompt-inspector-controller.js';

const empty = () => ({ version: 1, complete: false, reason: 'PUBLIC_EVENT_CAPTURE', sources: [], stages: [], events: [] });

test('trace stays within its UTF-8 JSON budget and rejected replacements preserve evidence', () => {
    const trace = empty(), limit = 2000, budget = createTraceBudget(trace, limit);
    for (let index = 0; index < 50; index++) {
        budget.put('sources', index, { id: index, text: '雪🍂"\\\n'.repeat(4) }, 256);
        assert.ok(Buffer.byteLength(JSON.stringify(trace)) <= limit);
    }
    const saved = structuredClone(trace);
    assert.equal(budget.put('sources', 0, { id: 0, text: '雪'.repeat(limit) }, 256), null);
    assert.deepEqual(trace, saved);
    assert.ok(budget.put('sources', 0, { id: 0, text: '小' }, 256));
    assert.equal(trace.sources[0].text, '小');
    assert.equal(trace.sources.length, saved.sources.length);
    assert.ok(budget.put('stages', 'final', { id: 'final', messages: [] }, 6));
    trace.reason = 'SOURCE_LIMIT'; trace.complete = true;
    assert.ok(Buffer.byteLength(JSON.stringify(trace)) <= limit);
});

test('bounded evidence does not repeatedly serialize already captured sources', () => {
    const trace = empty();
    let serializations = 0;
    Object.defineProperty(trace, 'toJSON', { value() { serializations++; return { sources: this.sources, stages: this.stages, events: this.events }; } });
    const budget = createTraceBudget(trace, 1024 * 1024);
    for (let id = 0; id < 256; id++) assert.ok(budget.put('sources', id, { id, text: '长提示词'.repeat(200) }, 256));
    assert.equal(serializations, 1);
    assert.equal(budget.put('sources', 256, { id: 256, text: 'extra' }, 256), null);
    assert.ok(budget.put('sources', 1, { id: 1, text: 'replacement' }, 256));
    assert.equal(trace.sources[1].text, 'replacement');
});

test('controller preserves source order, replacement evidence and request messages', async () => {
    const eventSource = new EventEmitter();
    const context = { mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'custom' },
        getChatCompletionModel: () => 'fixture-model', extensionSettings: {},
        eventSource, eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end' } };
    const controller = createPromptInspectorController({ context, getChatId: () => 'fixture-chat' });
    try {
        eventSource.emit('start', 'normal', {}, false);
        controller.observer.captureRuntimeSnapshot({ sources: Array.from({ length: 256 }, (_, index) => ({
            id: 'source-' + index, text: '原始🍂雪'.repeat(50), kind: 'history' })),
            stage: 'assembled', messages: [{ role: 'user', content: 'exact input' }] });
        controller.observer.captureRuntimeSnapshot({ sources: [{ id: 'source-1', text: 'changed', kind: 'history' }] });
        const request = { chat_completion_source: 'custom', model: 'fixture-model', messages: [{ role: 'user', content: 'exact input' }] };
        const reserved = await controller.reserveRequest(request);
        assert.equal(reserved.captureMode, 'frontend');
        assert.equal(reserved.trace.sources.length, 256);
        assert.equal(reserved.trace.sources[1].id, 'source-1');
        assert.equal(reserved.trace.sources[1].text, 'changed');
        assert.equal(reserved.trace.sources[1].originalText, '原始🍂雪'.repeat(50));
        assert.deepEqual(JSON.parse(reserved.rawRequest).messages, request.messages);
        assert.deepEqual(reserved.trace.stages.map(stage => stage.id), ['assembled', 'frontend-request']);
        assert.ok(Buffer.byteLength(JSON.stringify(reserved.trace)) <= 1024 * 1024);
    } finally { controller.destroy(); }
});
