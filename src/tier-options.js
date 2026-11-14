/* Local model-aware tier controls; SPDX-License-Identifier: MPL-2.0 */
import { TIER, AI_STUDIO_SOURCE, VERTEX_SOURCE } from './constants.js';
import { getTierSupport } from './model-policy.js';

export function getModelTierOptions(model, source = VERTEX_SOURCE) {
    if (source !== VERTEX_SOURCE && source !== AI_STUDIO_SOURCE) return [{ tier: TIER.STANDARD, allowed: true, level: 'excluded' }];
    return [TIER.STANDARD, TIER.FLEX].map(tier => ({ tier, ...getTierSupport(model, tier, source) }))
        .filter(option => option.allowed);
}

export function tierGuidanceKey(model, source = VERTEX_SOURCE) {
    const choices = getModelTierOptions(model, source);
    if (choices.length === 1) return 'vertex_paygo.guidance.standard_only';
    const suffix = choices.some(choice => choice.level === 'unverified') ? 'unverified' : 'supported';
    return `vertex_paygo.guidance.${source === AI_STUDIO_SOURCE ? 'ai_studio' : 'vertex'}_${suffix}`;
}

function matchesTextElement(node, tag, text, attributes) {
    if (node?.localName !== tag || node.textContent !== (text == null ? '' : String(text))) return false;
    if (node.childNodes.length > 1 || (node.firstChild && node.firstChild.nodeType !== 3)) return false;
    const entries = Object.entries(attributes);
    return node.attributes.length === entries.length
        && entries.every(([name, value]) => node.getAttribute(name) === value);
}

export function replaceTierOptions(select, choices, { selected, localize, documentRef = globalThis.document } = {}) {
    const available = choices.some(choice => choice.tier === selected);
    const options = [];
    if (!available) {
        options.push({ value: '', disabled: true, text: localize('vertex_paygo.tier.choose_supported') });
    }
    for (const choice of choices) {
        const name = localize(`vertex_paygo.tier.${choice.tier}`);
        options.push({ value: String(choice.tier), disabled: false, text: choice.level === 'unverified'
            ? `${name} (${localize('vertex_paygo.tier.unverified')})` : name });
    }
    const unchanged = select.children.length === options.length && options.every((option, index) =>
        matchesTextElement(select.children[index], 'option', option.text,
            option.disabled ? { value: option.value, disabled: '' } : { value: option.value }));
    if (!unchanged) {
        for (const child of [...select.children]) child.remove();
        for (const option of options) {
            const node = documentRef.createElement('option');
            node.value = option.value;
            node.disabled = option.disabled;
            node.hidden = false;
            node.textContent = option.text;
            select.append(node);
        }
    }
    select.value = available ? selected : '';
    return available;
}

export function tierGuidanceLines(_model, source = VERTEX_SOURCE) {
    return [
        { kind: 'lead', key: 'vertex_paygo.tier.guide.order' },
        { kind: 'description', tier: TIER.STANDARD, key: 'vertex_paygo.tier.guide.standard' },
        { kind: 'description', tier: TIER.FLEX, key: 'vertex_paygo.tier.guide.flex' },
        { kind: 'note', key: source === AI_STUDIO_SOURCE ? 'vertex_paygo.tier.guide.studio_limits' : 'vertex_paygo.tier.guide.vertex_limits' },
    ];
}

export function renderTierGuidance(root, model, source, { localize, documentRef = globalThis.document } = {}) {
    let parts = root.__vertexPayGoTierGuidance;
    if (!parts) {
        for (const child of [...root.children]) child.remove();
        root.textContent = '';
        const details = documentRef.createElement('details');
        details.className = 'vertex-paygo-tier-details';
        details.open = false;
        const summary = documentRef.createElement('summary');
        summary.className = 'vertex-paygo-tier-summary';
        const content = documentRef.createElement('div');
        content.className = 'vertex-paygo-tier-guidance-content';
        details.append(summary, content);
        root.append(details);
        parts = root.__vertexPayGoTierGuidance = { details, summary, content };
    }
    const summary = localize('vertex_paygo.tier.guide.summary');
    if (!matchesTextElement(parts.summary, 'summary', summary, { class: 'vertex-paygo-tier-summary' })) {
        parts.summary.textContent = summary;
    }
    const lines = tierGuidanceLines(model, source).map(line => ({ ...line, text: localize(line.key) }));
    if (parts.content.childNodes.length === lines.length && lines.every((line, index) =>
        matchesTextElement(parts.content.childNodes[index], 'small', line.text,
            { class: 'vertex-paygo-tier-' + line.kind, 'data-tier-guidance': line.tier ?? line.kind }))) return;
    for (const child of [...parts.content.children]) child.remove();
    parts.content.textContent = '';
    for (const line of lines) {
        const row = documentRef.createElement('small');
        row.className = 'vertex-paygo-tier-' + line.kind;
        row.setAttribute('data-tier-guidance', line.tier ?? line.kind);
        row.textContent = line.text;
        parts.content.append(row);
    }
}
