/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { normalizePrice, priceKey } from './cost-model.js';
import { isGoogleSource } from './constants.js';
import { getModelTierOptions, replaceTierOptions } from './tier-options.js';
import { createLocalizer } from './i18n.js';

function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function choiceLabel(name, value) {
    if (name === 'source') return ({ vertexai: 'Vertex AI', makersuite: 'Google AI Studio', custom: '自定义' })[value] ?? value;
    if (name === 'tier') return ({ standard: '标准', flex: 'Flex' })[value] ?? value;
    return value;
}

function readKey(getCurrentPricingKey) {
    const key = getCurrentPricingKey?.() ?? {};
    return Object.fromEntries(['source', 'model', 'tier'].map(name => [name, String(key[name] ?? '').trim()]));
}

export function createPriceSettingsUi({ documentRef = globalThis.document,
    getCurrentPricingKey, getPrices = () => ({}), getPriceInfo = () => ({ source: 'missing' }),
    setPrice, resetPrice, refreshCatalog, onChange } = {}) {
    const pricing = element(documentRef, 'section', 'vertex-paygo-cost-pricing');
    pricing.id = 'vertex-paygo-pricing-settings';
    const feedback = element(documentRef, 'p', 'vertex-paygo-cost-feedback');
    feedback.setAttribute('aria-live', 'polite');
    const note = element(documentRef, 'p', 'vertex-paygo-cost-pricing-note');
    pricing.append(element(documentRef, 'h4', 'vertex-paygo-group-title', '价格设置（美元 / 百万 token）'), note);
    const form = element(documentRef, 'form', 'vertex-paygo-cost-price-form');
    const priceMeta = element(documentRef, 'p', 'vertex-paygo-cost-price-meta');
    const keyFields = { source: '来源', model: '模型', tier: '服务层级' };
    const priceFields = {
        input: '输入', cachedInput: '缓存输入', output: '输出',
        longContextThreshold: '长上下文阈值（token）', longInput: '长上下文输入',
        longCachedInput: '长上下文缓存输入', longOutput: '长上下文输出',
    };
    const inputs = {};
    const keyRows = {};
    const tierFixed = element(documentRef, 'span', 'vertex-paygo-cost-tier-value');
    let currentKey = readKey(getCurrentPricingKey);
    const nativeSource = () => isGoogleSource(currentKey.source);
    const fallbackLocalize = createLocalizer();
    const localize = key => ({ 'vertex_paygo.tier.standard': '标准', 'vertex_paygo.tier.unverified': '未验证', 'vertex_paygo.tier.choose_supported': '请选择支持的层级' })[key] ?? fallbackLocalize(key);
    for (const [name, caption] of Object.entries(keyFields)) {
        const row = element(documentRef, name === 'tier' ? 'label' : 'div', 'vertex-paygo-cost-field');
        const label = element(documentRef, 'span', '', caption);
        label.title = name === 'tier'
            ? '仅选择对应服务层级的计价单价，不会更改实际请求层级。'
            : '跟随酒馆 API 界面的当前连接；请到 API 界面更改来源或模型。';
        const input = element(documentRef, name === 'tier' ? 'select' : 'span',
            name === 'tier' ? 'text_pole' : 'vertex-paygo-cost-' + name + '-value');
        if (name !== 'tier') {
            input.setAttribute('data-pricing-' + name, name === 'source' ? currentKey.source : '');
            input.setAttribute('contenteditable', 'false');
        } else {
            input.setAttribute('name', name);
            for (const value of ['standard', 'flex']) {
                const option = element(documentRef, 'option', '', choiceLabel(name, value));
                option.value = value;
                input.append(option);
            }
            input.value = currentKey[name];
        }
        row.append(label, input);
        if (name === 'tier') row.append(tierFixed);
        form.append(row);
        inputs[name] = input;
        keyRows[name] = row;
    }
    const priceInputs = {};
    for (const [name, caption] of Object.entries(priceFields)) {
        const row = element(documentRef, 'label', 'vertex-paygo-cost-field');
        const input = element(documentRef, 'input', 'text_pole');
        input.setAttribute('name', name);
        input.setAttribute('type', 'number');
        input.setAttribute('min', '0');
        input.setAttribute('step', 'any');
        row.append(element(documentRef, 'span', '', caption), input);
        form.append(row);
        priceInputs[name] = input;
    }
    const actions = element(documentRef, 'div', 'vertex-paygo-cost-price-actions');
    const save = element(documentRef, 'button', 'menu_button', '保存');
    save.setAttribute('type', 'submit');
    const reset = element(documentRef, 'button', 'menu_button', '清除');
    reset.setAttribute('type', 'button');
    const catalogRefresh = element(documentRef, 'button', 'menu_button vertex-paygo-icon-button');
    catalogRefresh.title = '更新支持列表和价格';
    catalogRefresh.setAttribute('aria-label', catalogRefresh.title);
    const refreshIcon = element(documentRef, 'i', 'fa-solid fa-rotate');
    refreshIcon.setAttribute('aria-hidden', 'true');
    catalogRefresh.append(refreshIcon);
    catalogRefresh.setAttribute('type', 'button');
    actions.append(save, reset, catalogRefresh);
    form.append(priceMeta, actions);
    pricing.append(form, feedback);

    function selectedKeyObject() {
        // Identity follows the connection, never editable/tampered display fields.
        // Keep the old hidden tier key for non-Google sources: no silent migration
        // or deletion of previously saved manual prices in this UI-only change.
        return { source: currentKey.source, model: currentKey.model,
            tier: nativeSource() ? inputs.tier.value.trim() : currentKey.tier };
    }
    // Kept for the cost-window integration; records/catalog entries no longer
    // populate an editable model/source picker or replace user-edited rates.
    function updateKeyLists() {
        const caption = choiceLabel('source', currentKey.source) || '未连接';
        inputs.source.textContent = caption;
        inputs.source.title = caption;
        inputs.source.setAttribute('data-pricing-source', currentKey.source);
        inputs.source.setAttribute('aria-label', '当前来源：' + caption);
    }
    function renderSourceState() {
        if (nativeSource()) {
            const selected = inputs.tier.value || currentKey.tier;
            const choices = getModelTierOptions(currentKey.model, currentKey.source);
            replaceTierOptions(inputs.tier, choices, { selected: choices.some(choice => choice.tier === selected) ? selected : 'standard', localize, documentRef });
            inputs.tier.hidden = choices.length === 1;
            tierFixed.hidden = choices.length !== 1;
            tierFixed.textContent = choiceLabel('tier', choices[0]?.tier ?? 'standard');
        }
        keyRows.tier.hidden = !nativeSource();
        inputs.tier.disabled = !nativeSource();
        if (!currentKey.source) {
            note.textContent = '请先在酒馆 API 界面选择连接与模型，再设置当前模型的价格表。';
        } else if (currentKey.source === 'vertexai') {
            note.textContent = '自动价格为公开付费文本单价；Vertex 按 Global 基础价。地区差价、免费额度和账户折扣请手动调整。';
        } else if (currentKey.source === 'makersuite') {
            note.textContent = '自动价格为 Google AI Studio 的公开付费文本单价；免费额度和账户折扣请手动调整。';
        } else {
            note.textContent = '为当前使用渠道设置当前模型的价格表；此处仅保存单价，当前渠道的用量采集尚未接入。';
        }
        reset.textContent = '清除';
        reset.title = nativeSource() ? '清除手动单价，恢复自动价格' : '清除当前模型的手动价格';
        reset.disabled = typeof resetPrice !== 'function' || !currentKey.source || !currentKey.model;
        catalogRefresh.hidden = !nativeSource();
        catalogRefresh.disabled = !nativeSource() || typeof refreshCatalog !== 'function';
        save.disabled = typeof setPrice !== 'function' || !currentKey.source || !currentKey.model;
    }
    function renderPriceMeta() {
        const info = getPriceInfo?.(selectedKeyObject()) ?? { source: 'missing' };
        const labels = nativeSource()
            ? { manual: '手动价格', catalog: '自动价格', missing: '当前渠道尚未设置价格' }
            : { manual: '手动价格', catalog: '参考价格', missing: '当前渠道尚未设置价格' };
        const parts = [labels[info.source] ?? labels.missing];
        if (nativeSource() && info.updatedAt) parts.push(`${info.source === 'missing' ? '价格表更新' : '核验'} ${info.updatedAt}`);
        if (nativeSource() && info.validUntil) parts.push(`有效至 ${info.validUntil}`);
        priceMeta.replaceChildren(element(documentRef, 'span', '', parts.join(' · ')));
        if (nativeSource() && typeof info.sourceUrl === 'string' && info.sourceUrl.startsWith('https://')) {
            const link = element(documentRef, 'a', '', '官方来源');
            link.href = info.sourceUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            priceMeta.append(element(documentRef, 'span', '', ' · '), link);
        }
    }
    function loadSelectedPrice() {
        const selected = normalizePrice((getPrices?.() ?? {})[priceKey(selectedKeyObject())]) ?? {};
        for (const [name, input] of Object.entries(priceInputs)) input.value = selected[name] ?? '';
        renderPriceMeta();
    }
    function syncCurrentKey() {
        currentKey = readKey(getCurrentPricingKey);
        updateKeyLists();
        for (const [name, input] of Object.entries(inputs)) {
            if (name === 'model') {
                input.textContent = currentKey.model || '未选择模型';
                input.title = currentKey.model;
                input.setAttribute('aria-label', currentKey.model ? '当前模型：' + currentKey.model : '未选择模型');
            } else if (name === 'tier') input.value = currentKey[name];
        }
        renderSourceState();
        loadSelectedPrice();
    }
    function syncIfConnectionChanged() {
        const next = readKey(getCurrentPricingKey);
        if (Object.keys(next).every(name => next[name] === currentKey[name])) return false;
        syncCurrentKey();
        return true;
    }
    function checkTargetBeforeWrite() {
        if (!syncIfConnectionChanged()) return true;
        feedback.textContent = '当前连接已变化，价格页已更新；请确认当前模型的价格后重新操作。';
        feedback.dataset.state = 'error';
        return false;
    }
    inputs.tier.addEventListener('change', () => { if (nativeSource()) loadSelectedPrice(); });
    form.addEventListener('submit', async event => {
        event.preventDefault?.();
        if (!checkTargetBeforeWrite()) return;
        const key = selectedKeyObject();
        const raw = Object.fromEntries(Object.entries(priceInputs).map(([name, input]) => [name, input.value]));
        const price = normalizePrice(raw);
        if (!key.source || !key.model || !key.tier || !price) {
            feedback.textContent = '请先在酒馆 API 界面选择连接与模型，再填写非负的输入/缓存/输出价格；长上下文价格须成组填写。';
            feedback.dataset.state = 'error';
            return;
        }
        try {
            if (typeof setPrice !== 'function') throw new Error('价格保存接口不可用');
            await setPrice(key, price);
            feedback.textContent = '价格已保存。';
            feedback.dataset.state = 'success';
            if (!syncIfConnectionChanged()) loadSelectedPrice();
            await onChange?.();
        } catch (error) {
            feedback.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
            feedback.dataset.state = 'error';
        }
    });
    reset.addEventListener('click', async () => {
        if (!checkTargetBeforeWrite()) return;
        const wasNative = nativeSource();
        reset.disabled = true;
        try {
            if (typeof resetPrice !== 'function') throw new Error('价格清除接口不可用');
            await resetPrice(selectedKeyObject());
            if (!syncIfConnectionChanged()) loadSelectedPrice();
            feedback.textContent = wasNative ? '已恢复自动价格。' : '已清除手动价格。';
            feedback.dataset.state = 'success';
            await onChange?.();
        } catch (error) {
            feedback.textContent = `操作失败：${error instanceof Error ? error.message : String(error)}`;
            feedback.dataset.state = 'error';
        } finally { renderSourceState(); }
    });
    catalogRefresh.addEventListener('click', async () => {
        if (!nativeSource() || typeof refreshCatalog !== 'function') return;
        catalogRefresh.disabled = true;
        try {
            const result = await refreshCatalog();
            if (!result?.applied) {
                feedback.textContent = `更新失败，已保留现有价格${result?.error ? `：${result.error}` : '。'}`;
                feedback.dataset.state = 'error';
                return;
            }
            updateKeyLists();
            if (!syncIfConnectionChanged()) loadSelectedPrice();
            feedback.textContent = result.changed ? '支持列表和价格已更新。' : '支持列表和价格已是最新。';
            feedback.dataset.state = 'success';
            await onChange?.();
        } catch (error) {
            feedback.textContent = `更新失败，已保留现有价格：${error instanceof Error ? error.message : String(error)}`;
            feedback.dataset.state = 'error';
        } finally { renderSourceState(); }
    });
    syncCurrentKey();
    return { root: pricing, updateKeyLists, renderPriceMeta, syncCurrentKey, syncIfConnectionChanged,
        destroy() { pricing.remove(); } };
}
