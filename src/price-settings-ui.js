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

function choiceLabel(name, value, localize) {
    if (name === 'source') return ({ vertexai: 'Vertex AI', makersuite: 'Google AI Studio', custom: localize('vertex_paygo.pricing.source_custom') })[value] ?? value;
    if (name === 'tier' && ['standard', 'flex'].includes(value)) return localize('vertex_paygo.tier.' + value);
    return value;
}

function readKey(getCurrentPricingKey) {
    const key = getCurrentPricingKey?.() ?? {};
    return Object.fromEntries(['source', 'model', 'tier'].map(name => [name, String(key[name] ?? '').trim()]));
}

export function createPriceSettingsUi({ documentRef = globalThis.document, context,
    getCurrentPricingKey, getPrices = () => ({}), getPriceInfo = () => ({ source: 'missing' }),
    setPrice, resetPrice, refreshCatalog, onChange,
    localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key)) } = {}) {
    const t = (key, values) => localize('vertex_paygo.pricing.' + key, values);
    const pricing = element(documentRef, 'section', 'vertex-paygo-cost-pricing');
    pricing.id = 'vertex-paygo-pricing-settings';
    const feedback = element(documentRef, 'p', 'vertex-paygo-cost-feedback');
    feedback.setAttribute('aria-live', 'polite');
    const note = element(documentRef, 'p', 'vertex-paygo-cost-pricing-note');
    pricing.append(element(documentRef, 'h4', 'vertex-paygo-group-title', t('title')), note);
    const form = element(documentRef, 'form', 'vertex-paygo-cost-price-form');
    const priceMeta = element(documentRef, 'p', 'vertex-paygo-cost-price-meta');
    const keyFields = { source: t('source'), model: t('model'), tier: t('tier') };
    const priceFields = {
        input: t('input'), cachedInput: t('cached_input'), output: t('output'),
        longContextThreshold: t('long_threshold'), longInput: t('long_input'),
        longCachedInput: t('long_cached_input'), longOutput: t('long_output'),
    };
    const inputs = {};
    const keyRows = {};
    const tierFixed = element(documentRef, 'span', 'vertex-paygo-cost-tier-value');
    let currentKey = readKey(getCurrentPricingKey);
    const nativeSource = () => isGoogleSource(currentKey.source);
    for (const [name, caption] of Object.entries(keyFields)) {
        const row = element(documentRef, name === 'tier' ? 'label' : 'div', 'vertex-paygo-cost-field');
        const label = element(documentRef, 'span', '', caption);
        label.title = name === 'tier'
            ? t('tier_hint') : t('connection_hint');
        const input = element(documentRef, name === 'tier' ? 'select' : 'span',
            name === 'tier' ? 'text_pole' : 'vertex-paygo-cost-' + name + '-value');
        if (name !== 'tier') {
            input.setAttribute('data-pricing-' + name, name === 'source' ? currentKey.source : '');
            input.setAttribute('contenteditable', 'false');
        } else {
            input.setAttribute('name', name);
            for (const value of ['standard', 'flex']) {
                const option = element(documentRef, 'option', '', choiceLabel(name, value, localize));
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
    const save = element(documentRef, 'button', 'menu_button', t('save'));
    save.setAttribute('type', 'submit');
    const reset = element(documentRef, 'button', 'menu_button', t('clear'));
    reset.setAttribute('type', 'button');
    const catalogRefresh = element(documentRef, 'button', 'menu_button vertex-paygo-icon-button');
    catalogRefresh.title = t('refresh');
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
        const caption = choiceLabel('source', currentKey.source, localize) || t('unconnected');
        inputs.source.textContent = caption;
        inputs.source.title = caption;
        inputs.source.setAttribute('data-pricing-source', currentKey.source);
        inputs.source.setAttribute('aria-label', t('current_source', { value: caption }));
    }
    function renderSourceState() {
        if (nativeSource()) {
            const selected = inputs.tier.value || currentKey.tier;
            const choices = getModelTierOptions(currentKey.model, currentKey.source);
            replaceTierOptions(inputs.tier, choices, { selected: choices.some(choice => choice.tier === selected) ? selected : 'standard', localize, documentRef });
            inputs.tier.hidden = choices.length === 1;
            tierFixed.hidden = choices.length !== 1;
            tierFixed.textContent = choiceLabel('tier', choices[0]?.tier ?? 'standard', localize);
        }
        keyRows.tier.hidden = !nativeSource();
        inputs.tier.disabled = !nativeSource();
        if (!currentKey.source) {
            note.textContent = t('note_unconnected');
        } else if (currentKey.source === 'vertexai') {
            note.textContent = t('note_vertex');
        } else if (currentKey.source === 'makersuite') {
            note.textContent = t('note_studio');
        } else {
            note.textContent = t('note_other');
        }
        reset.textContent = t('clear');
        reset.title = t(nativeSource() ? 'clear_auto' : 'clear_manual');
        reset.disabled = typeof resetPrice !== 'function' || !currentKey.source || !currentKey.model;
        catalogRefresh.hidden = !nativeSource();
        catalogRefresh.disabled = !nativeSource() || typeof refreshCatalog !== 'function';
        save.disabled = typeof setPrice !== 'function' || !currentKey.source || !currentKey.model;
    }
    function renderPriceMeta() {
        const info = getPriceInfo?.(selectedKeyObject()) ?? { source: 'missing' };
        const labels = nativeSource()
            ? { manual: t('manual'), catalog: t('catalog'), missing: t('missing') }
            : { manual: t('manual'), catalog: t('reference'), missing: t('missing') };
        const parts = [labels[info.source] ?? labels.missing];
        if (nativeSource() && info.updatedAt) parts.push(t(info.source === 'missing' ? 'catalog_updated' : 'verified', { date: info.updatedAt }));
        if (nativeSource() && info.validUntil) parts.push(t('valid_until', { date: info.validUntil }));
        priceMeta.replaceChildren(element(documentRef, 'span', '', parts.join(' · ')));
        if (nativeSource() && typeof info.sourceUrl === 'string' && info.sourceUrl.startsWith('https://')) {
            const link = element(documentRef, 'a', '', t('official_source'));
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
                input.textContent = currentKey.model || t('select_model');
                input.title = currentKey.model;
                input.setAttribute('aria-label', currentKey.model ? t('current_model', { value: currentKey.model }) : t('select_model'));
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
        feedback.textContent = t('connection_changed');
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
            feedback.textContent = t('invalid_price');
            feedback.dataset.state = 'error';
            return;
        }
        try {
            if (typeof setPrice !== 'function') throw new Error(t('save_unavailable'));
            await setPrice(key, price);
            feedback.textContent = t('saved');
            feedback.dataset.state = 'success';
            if (!syncIfConnectionChanged()) loadSelectedPrice();
            await onChange?.();
        } catch (error) {
            feedback.textContent = t('save_failed', { error: error instanceof Error ? error.message : String(error) });
            feedback.dataset.state = 'error';
        }
    });
    reset.addEventListener('click', async () => {
        if (!checkTargetBeforeWrite()) return;
        const wasNative = nativeSource();
        reset.disabled = true;
        try {
            if (typeof resetPrice !== 'function') throw new Error(t('clear_unavailable'));
            await resetPrice(selectedKeyObject());
            if (!syncIfConnectionChanged()) loadSelectedPrice();
            feedback.textContent = t(wasNative ? 'automatic_restored' : 'manual_cleared');
            feedback.dataset.state = 'success';
            await onChange?.();
        } catch (error) {
            feedback.textContent = t('operation_failed', { error: error instanceof Error ? error.message : String(error) });
            feedback.dataset.state = 'error';
        } finally { renderSourceState(); }
    });
    catalogRefresh.addEventListener('click', async () => {
        if (!nativeSource() || typeof refreshCatalog !== 'function') return;
        catalogRefresh.disabled = true;
        try {
            const result = await refreshCatalog();
            if (!result?.applied) {
                feedback.textContent = result?.error ? t('refresh_failed_detail', { error: String(result.error) }) : t('refresh_failed');
                feedback.dataset.state = 'error';
                return;
            }
            updateKeyLists();
            if (!syncIfConnectionChanged()) loadSelectedPrice();
            feedback.textContent = t(result.changed ? 'catalog_changed' : 'catalog_current');
            feedback.dataset.state = 'success';
            await onChange?.();
        } catch (error) {
            feedback.textContent = t('refresh_failed_detail', { error: error instanceof Error ? error.message : String(error) });
            feedback.dataset.state = 'error';
        } finally { renderSourceState(); }
    });
    syncCurrentKey();
    return { root: pricing, updateKeyLists, renderPriceMeta, syncCurrentKey, syncIfConnectionChanged,
        destroy() { pricing.remove(); } };
}
