/* World-info cache stability; based on ST-Vertex-PayGo (MPL-2.0). */

/** Call only within a non-dry foreground generation. The native final loop
 * uses state.next === 0; some hosts also expose explicit flags. */
export function isFinalWorldInfoScan(args) {
    try {
        if (!args || typeof args !== 'object') return false;
        if (args.isDryRun !== undefined && typeof args.isDryRun !== 'boolean') return false;
        if (args.isFinal !== undefined && typeof args.isFinal !== 'boolean') return false;
        if (args.isDryRun === true || args.isFinal === false) return false;
        const next = args.state?.next;
        if (next !== undefined && next !== 0) return false;
        return args.isFinal === true || next === 0;
    } catch { return false; }
}

export const WORLDINFO_STABILITY_SETTINGS_KEY = 'vertex-paygo-worldinfo-stability';

function initializeWorldInfoStabilitySettings(context) {
    const settings = context?.extensionSettings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || typeof context.saveSettingsDebounced !== 'function') return;
    const stored = settings[WORLDINFO_STABILITY_SETTINGS_KEY];
    if (typeof stored?.enabled === 'boolean') return;
    const existed = Object.hasOwn(settings, WORLDINFO_STABILITY_SETTINGS_KEY);
    try {
        settings[WORLDINFO_STABILITY_SETTINGS_KEY] = {
            ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
            enabled: true,
        };
        context.saveSettingsDebounced();
    } catch {
        // The implicit ON default still works when the host cannot save settings.
        try {
            if (existed) settings[WORLDINFO_STABILITY_SETTINGS_KEY] = stored;
            else delete settings[WORLDINFO_STABILITY_SETTINGS_KEY];
        } catch { /* Read-only host settings retain their original value. */ }
    }
}

// Stay within one book and the exact insertion configuration. In particular,
// do not infer a host's default depth/role, change author priorities, or sort
// the pre-scan candidates (which would affect triggering and budget selection).
function groupKey(entry) {
    if (!entry || typeof entry.world !== 'string' || !entry.world
        || !Number.isSafeInteger(entry.uid) || entry.uid < 0
        || typeof entry.order !== 'number' || !Number.isFinite(entry.order)
        || !Number.isInteger(entry.position) || entry.position < 0 || entry.position > 7) return null;
    if (entry.depth != null && (typeof entry.depth !== 'number' || !Number.isFinite(entry.depth))) return null;
    if (entry.role != null && !Number.isInteger(entry.role)) return null;
    if (entry.outletName != null && typeof entry.outletName !== 'string') return null;
    return JSON.stringify([entry.world, entry.order, entry.position,
        entry.depth ?? null, entry.role ?? null, entry.outletName ?? null]);
}

function describe(entry) {
    // Observability only: never retain prompt bodies, comments or trigger keys.
    return {
        world: typeof entry?.world === 'string' ? entry.world : null,
        uid: Number.isSafeInteger(entry?.uid) ? entry.uid : null,
        order: typeof entry?.order === 'number' && Number.isFinite(entry.order) ? entry.order : null,
        position: Number.isInteger(entry?.position) ? entry.position : null,
        depth: typeof entry?.depth === 'number' && Number.isFinite(entry.depth) ? entry.depth : null,
        role: Number.isInteger(entry?.role) ? entry.role : null,
        constant: entry?.constant === true,
        outletName: typeof entry?.outletName === 'string' ? entry.outletName : null,
    };
}

export { groupKey as worldInfoGroupKey, describe as describeWorldInfoEntry };

/** Reorders only the existing slots of equivalent entries in the same Map. */
export function stabilizeActivatedWorldInfo(entries) {
    if (!(entries instanceof Map)) return { valid: false, groups: 0, changed: 0, before: [], after: [] };
    const original = [...entries];
    const result = [...original];
    const groups = new Map();
    for (let index = 0; index < original.length; index++) {
        const key = groupKey(original[index][1]);
        if (key === null) continue;
        const indices = groups.get(key) ?? [];
        indices.push(index);
        groups.set(key, indices);
    }
    let eligibleGroups = 0;
    for (const indices of groups.values()) {
        if (indices.length < 2) continue;
        const members = indices.map(index => original[index]);
        // An ambiguous identity must not be resolved by sorting prompt text.
        if (new Set(members.map(([, entry]) => entry.uid)).size !== members.length) continue;
        eligibleGroups++;
        members.sort(([, left], [, right]) => left.uid - right.uid);
        indices.forEach((index, rank) => { result[index] = members[rank]; });
    }
    const changed = result.filter((pair, index) => pair !== original[index]).length;
    if (changed) {
        entries.clear();
        for (const [key, entry] of result) entries.set(key, entry);
    }
    return { valid: true, groups: eligibleGroups, changed,
        before: original.map(([, entry]) => describe(entry)),
        after: result.map(([, entry]) => describe(entry)) };
}

const ORDER_LIMITS = Object.freeze({ entries: 512, groups: 32, items: 128, textBytes: 128 * 1024, itemChars: 32768 });
const FOREGROUND_TYPES = new Set([undefined, null, '', 'normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);

function frontendOrderReceipt(plan, messages, epoch, sequence) {
    if (plan?.version !== 1 || !Array.isArray(plan.groups) || !Array.isArray(messages)) return null;
    const texts = messages.filter(message => message?.role !== 'tool').flatMap(message =>
        typeof message?.content === 'string' ? [message.content]
            : Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'text'
                && typeof part.text === 'string').map(part => part.text) : []);
    const length = texts.reduce((sum, text) => sum + text.length, 0);
    const items = plan.groups.reduce((sum, group) => sum + (group.items?.length ?? 0), 0);
    if (length > 2 * 1024 * 1024 || length * items > 32 * 1024 * 1024) return null;
    const uniquePosition = needle => {
        let found = null;
        for (let part = 0; part < texts.length; part++) {
            const start = texts[part].indexOf(needle);
            if (start < 0) continue;
            if (found || texts[part].indexOf(needle, start + 1) >= 0) return null;
            found = { part, start, end: start + needle.length };
        }
        return found;
    };
    return { version: 1, phase: 'frontend', token: plan.token, epoch, sequence,
        groups: plan.groups.map(group => {
            let previous = null, confirmed = true;
            for (const item of group.items) {
                const position = typeof item.text === 'string' && item.text.length ? uniquePosition(item.text) : null;
                if (!position || (previous && (position.part < previous.part
                    || (position.part === previous.part && position.start < previous.end)))) { confirmed = false; break; }
                previous = position;
            }
            return { id: group.id, status: confirmed ? 'confirmed' : 'unverified',
                items: confirmed ? group.items.map(item => item.id) : [] };
        }) };
}
async function digestText(text) {
    const bytes = new TextEncoder().encode(text);
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Build a final-presentation plan, then change only the existing equivalent slots.
 * History contains opaque identities and fingerprints, never prompt text. */
export async function planAdaptiveWorldInfo(entries, { history = new Map(), salt = '',
    renderEntryText = entry => entry.content, reverseFor = entry => entry.position !== 7,
    digest = digestText, canApply = () => true } = {}) {
    const empty = reason => ({ report: { valid: false, reason, groups: 0, changed: 0, before: [], after: [] }, groups: [] });
    if (!(entries instanceof Map)) return empty('INVALID_SCAN');
    if (entries.size > ORDER_LIMITS.entries) return empty('SCAN_TOO_LARGE');
    const original = [...entries], result = [...original], grouped = new Map();
    original.forEach(([, entry], index) => { const key = groupKey(entry); if (key !== null) {
        const positions = grouped.get(key) ?? []; positions.push(index); grouped.set(key, positions);
    } });
    const plans = [];
    let retained = 0, added = 0, skipped = 0, itemCount = 0, textBytes = 0;
    for (const [key, positions] of grouped) {
        if (plans.length >= ORDER_LIMITS.groups || new Set(positions.map(index => original[index][1].uid)).size !== positions.length) { skipped++; continue; }
        const rendered = positions.map(index => ({ index, pair: original[index], text: renderEntryText(original[index][1]) }));
        const visible = rendered.filter(item => typeof item.text === 'string' && item.text.trim().length > 0);
        const bytes = visible.reduce((sum, item) => sum + new TextEncoder().encode(item.text).length, 0);
        if (rendered.some(item => typeof item.text !== 'string') || !visible.length || visible.some(item => item.text.length > ORDER_LIMITS.itemChars)
            || itemCount + visible.length > ORDER_LIMITS.items || textBytes + bytes > ORDER_LIMITS.textBytes) { skipped++; continue; }
        const members = await Promise.all(visible.map(async item => ({ ...item, uid: item.pair[1].uid,
            constant: item.pair[1].constant === true,
            id: await digest(salt + '\0identity\0' + key + '\0' + item.pair[1].uid),
            fingerprint: await digest(salt + '\0text\0' + item.text) })));
        const old = history.get(key)?.green ?? [], greens = members.filter(item => !item.constant);
        const oldRetained = old.map(item => greens.find(member => member.id === item.id && member.fingerprint === item.fingerprint)).filter(Boolean);
        const keptIds = new Set(oldRetained.map(item => item.id));
        const newGreen = greens.filter(item => !keptIds.has(item.id)).sort((a, b) => a.uid - b.uid);
        const blues = members.filter(item => item.constant).sort((a, b) => a.uid - b.uid);
        const final = [...blues, ...oldRetained, ...newGreen];
        // Most native WI positions use unshift; outlet uses push. A forward
        // scan Map would otherwise put green before blue in the wire text.
        const inMap = reverseFor(members[0].pair[1]) ? [...final].reverse() : final;
        visible.forEach((item, index) => { result[item.index] = inMap[index].pair; });
        plans.push({ key, id: await digest(salt + '\0group\0' + key), items: final });
        retained += oldRetained.length; added += newGreen.length; itemCount += visible.length; textBytes += bytes;
    }
    if (!canApply()) return empty('STALE_SCAN');
    const changed = result.filter((pair, index) => pair !== original[index]).length;
    if (changed) {
        // Atomic rollback protects the host even when another extension has
        // replaced the public Map methods. Do not rewrite an unchanged Map.
        try { entries.clear(); for (const [key, entry] of result) entries.set(key, entry); }
        catch { Map.prototype.clear.call(entries); for (const [key, entry] of original) Map.prototype.set.call(entries, key, entry); return empty('MAP_WRITE_FAILED'); }
    }
    return { groups: plans, report: { valid: true, groups: plans.length, changed, retained, added, skipped,
        before: original.map(([, entry]) => describe(entry)), after: result.map(([, entry]) => describe(entry)),
        planned: plans.map(group => ({ entries: group.items.map(item => ({ uid: item.uid, constant: item.constant })) })) } };
}

export function completionIdentity(current) {
    const settings = current?.chatCompletionSettings, source = settings?.chat_completion_source;
    if (!settings || typeof source !== 'string' || !/^[a-z0-9_-]{1,64}$/u.test(source)) return null;
    const fields = { vertexai: 'vertexai_model', makersuite: 'google_model', custom: 'custom_model', openai: 'openai_model', claude: 'claude_model' };
    let model; try { model = current?.getChatCompletionModel?.() ?? settings[fields[source] ?? `${source}_model`]; } catch { return null; }
    if (typeof model !== 'string' || !model.trim()) return null;
    return { source, model };
}

export function installWorldInfoStability({ context, getContext = () => context, onChange = () => {},
    renderEntryText = entry => entry.content, reverseFor = entry => entry.position !== 7,
    digest = digestText, idFactory = () => globalThis.crypto.randomUUID(),
    receiptAttempts = 6, receiptDelayMs = 250 } = {}) {
    initializeWorldInfoStabilitySettings(getContext());
    const event = context?.eventTypes?.WORLDINFO_SCAN_DONE;
    const hookKind = typeof event === 'string' ? 'native' : null;
    const source = context?.eventSource;
    const supported = typeof event === 'string' && typeof source?.on === 'function' && typeof source?.removeListener === 'function'
        && !!context?.extensionSettings && typeof context?.saveSettingsDebounced === 'function'
        && typeof digest === 'function' && (digest !== digestText || !!globalThis.crypto?.subtle);
    const histories = new Map(), pending = new Map(), listeners = [], timers = new Set();
    const salt = supported ? idFactory() : '';
    let relocatedGreen = false, relocatedSources = false;
    let destroyed = false, generation = null, serial = 0, scanSerial = 0, frontendSequence = 0, candidate = null, lastScan = null, lastConfirmation = null;
    // Default ON; a user's explicitly saved OFF remains authoritative.
    const enabled = () => getContext()?.extensionSettings?.[WORLDINFO_STABILITY_SETTINGS_KEY]?.enabled !== false;
    function scope() {
        const current = getContext(), settings = current?.chatCompletionSettings;
        const chat = current?.getCurrentChatId?.();
        const source = settings?.chat_completion_source;
        if (typeof chat !== 'string' || !chat || (current?.mainApi != null && current.mainApi !== 'openai')
            || !completionIdentity(current)) return null;
        const model = completionIdentity(current).model;
        return JSON.stringify([current.groupId ?? null, current.characterId ?? null, chat, source, model,
            source === 'vertexai' ? settings.vertexai_region ?? 'us-central1' : null,
            source === 'vertexai' ? settings.vertexai_auth_mode ?? null : null,
            source === 'vertexai' ? settings.vertexai_express_project_id ?? null : null,
            current.extensionSettings?.connectionManager?.selectedProfile ?? null,
            settings.custom_url ?? null, settings.reverse_proxy ?? null]);
    }
    const snapshot = () => ({ supported, hookKind, enabled: enabled(), lastScan: lastScan ? structuredClone(lastScan) : null,
        lastConfirmation: lastConfirmation ? { ...lastConfirmation } : null, pending: pending.size, memoryOnly: true });
    const changed = () => { try { onChange(snapshot()); } catch { /* UI must not affect generation. */ } };
    const listen = (name, handler, last = false) => { if (typeof name === 'string') {
        listeners.push([name, handler]);
        if (last && typeof source.makeLast === 'function') source.makeLast(name, handler);
        else source.on(name, handler);
    } };
    const clearDraft = () => { relocatedGreen = false; relocatedSources = false; scanSerial++; candidate = null; lastScan = null; lastConfirmation = null; pending.clear(); changed(); };
    const sleep = ms => new Promise(resolve => { const record = { resolve }; record.timer = setTimeout(() => { timers.delete(record); resolve(); }, ms); timers.add(record); });
    if (supported) {
        listen(context.eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
            clearDraft(); generation = { serial: ++serial, active: dryRun === false && FOREGROUND_TYPES.has(type), scope: scope() };
        });
        listen(event, async args => {
            if (destroyed || !enabled() || !generation?.active || !scope() || scope() !== generation.scope) return;
            if (!isFinalWorldInfoScan(args)) return;
            const seq = ++scanSerial, ownGeneration = generation.serial, ownScope = generation.scope;
            try {
                const plan = await planAdaptiveWorldInfo(args?.activated?.entries, { history: histories.get(ownScope)?.groups ?? new Map(),
                    salt: salt + ownScope, renderEntryText, reverseFor, digest,
                    canApply: () => !destroyed && enabled() && scanSerial === seq && generation?.serial === ownGeneration && scope() === ownScope });
                if (destroyed || scanSerial !== seq || generation?.serial !== ownGeneration || scope() !== ownScope) return;
                lastScan = plan.report;
                candidate = plan.report.valid ? { scope: ownScope, serial: ownGeneration, groups: plan.groups } : null;
                changed();
            } catch { if (!destroyed && scanSerial === seq) { candidate = null; lastScan = { valid: false, reason: 'SCAN_PLAN_FAILED', groups: 0, changed: 0, before: [], after: [] }; changed(); } }
        }, true);
        for (const name of ['CHAT_CHANGED', 'SETTINGS_LOADED', 'MESSAGE_SWIPED', 'CHATCOMPLETION_SOURCE_CHANGED']) listen(context.eventTypes[name], () => { generation = null; clearDraft(); });
        listen(context.eventTypes.GENERATION_ENDED, () => {
            if (generation) generation.active = false; candidate = null;
            // Release drafts that never reached transport, but keep claimed
            // requests long enough for their read-only wire receipt to arrive.
            for (const [token, item] of pending) if (!item.claimed) pending.delete(token);
        });
        listen(context.eventTypes.GENERATION_STOPPED, () => { if (generation) generation.active = false; candidate = null; pending.clear(); changed(); });
    }
    function cancelRequest(token, reason = 'not-sent') {
        if (!pending.delete(token)) return;
        lastConfirmation = { status: reason, confirmedGroups: 0 }; changed();
    }
    function acceptReceipt(token, receipt) {
        const item = pending.get(token);
        if (!item || destroyed || !enabled() || item.scope !== scope()) { pending.delete(token); return false; }
        if (receipt?.token !== token) { cancelRequest(token, 'invalid-receipt'); return false; }
        if (receipt.version !== 1 || !Array.isArray(receipt.groups) || receipt.groups.length > 32 || new Set(receipt.groups.map(group => group?.id)).size !== receipt.groups.length || typeof receipt.epoch !== 'string' || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) { cancelRequest(token, 'invalid-receipt'); return false; }
        const previous = histories.get(item.scope);
        if (previous?.epoch === receipt.epoch && previous.sequence >= receipt.sequence) { pending.delete(token); changed(); return false; }
        const groups = new Map();
        for (const plan of item.groups) {
            const confirmed = receipt.groups?.find(group => group.id === plan.id && group.status === 'confirmed');
            if (!confirmed || JSON.stringify(confirmed.items) !== JSON.stringify(plan.items.map(member => member.id))) continue;
            groups.set(plan.key, { green: plan.items.filter(member => !member.constant).map(member => ({ id: member.id, fingerprint: member.fingerprint })) });
        }
        histories.delete(item.scope); histories.set(item.scope, { epoch: receipt.epoch, sequence: receipt.sequence, groups });
        if (histories.size > 32) histories.delete(histories.keys().next().value);
        pending.delete(token); lastConfirmation = { status: groups.size ? 'confirmed' : 'unverified', confirmedGroups: groups.size,
            sequence: receipt.sequence, ...(receipt.phase === 'frontend' ? { phase: 'frontend' } : {}) };
        changed(); return groups.size > 0;
    }
    return {
        snapshot,
        setGreenRelocated(value) { relocatedGreen = value === true; },
        setSourceRelocated(value) { relocatedSources = value === true; },
        captureRequest(data, { background = false, chatId } = {}) {
            if (destroyed || !enabled() || background || !chatId || !generation?.active || !candidate?.groups.length
                || candidate.scope !== scope() || candidate.serial !== generation.serial) return null;
            const current = getContext().chatCompletionSettings;
            if (data?.chat_completion_source !== current.chat_completion_source
                || data?.model !== completionIdentity(getContext())?.model
                || (current.chat_completion_source === 'vertexai' && (data.vertexai_region || 'us-central1') !== (current.vertexai_region || 'us-central1'))) return null;
            if (typeof data.custom_url === 'string' && typeof current.custom_url === 'string' && data.custom_url !== current.custom_url) return null;
            if (typeof data.reverse_proxy === 'string' && typeof current.reverse_proxy === 'string' && data.reverse_proxy !== current.reverse_proxy) return null;
            const token = idFactory();
            if (pending.size >= 8) pending.delete(pending.keys().next().value);
            pending.set(token, { ...candidate, chatId, claimed: false, groups: candidate.groups.map(group => ({ ...group, items: group.items.filter(item => !((relocatedGreen || relocatedSources) && group.items.some(member => !member.constant)) || !item.constant).map(item => ({ id: item.id, fingerprint: item.fingerprint, uid: item.uid, constant: item.constant, text: item.text })) })).filter(group => group.items.length) });
            return token;
        },
        requestPlan(token, data) {
            const item = pending.get(token);
            if (!item || destroyed || !enabled() || item.scope !== scope() || data?.model !== completionIdentity(getContext())?.model || data?.chat_completion_source !== completionIdentity(getContext())?.source
                || (data.chat_completion_source === 'vertexai' && (data.vertexai_region || 'us-central1') !== (getContext().chatCompletionSettings.vertexai_region || 'us-central1'))) return null;
            const endpointSettings = getContext().chatCompletionSettings;
            if ((typeof data.custom_url === 'string' && typeof endpointSettings.custom_url === 'string' && data.custom_url !== endpointSettings.custom_url)
                || (typeof data.reverse_proxy === 'string' && typeof endpointSettings.reverse_proxy === 'string' && data.reverse_proxy !== endpointSettings.reverse_proxy)) return null;
            item.claimed = true;
            return { version: 1, token, groups: item.groups.map(group => ({ id: group.id, items: group.items.map(member => ({ id: member.id, text: member.text.trim() })) })) };
        },
        cancelRequest,
        captureFrontendReceipt(token, data, plan) {
            const item = pending.get(token), identity = completionIdentity(getContext());
            if (!item || !item.claimed || destroyed || !enabled() || item.scope !== scope() || plan?.token !== token
                || !['custom', 'openai', 'claude', 'vertexai', 'makersuite'].includes(data?.chat_completion_source)
                || data.model !== identity?.model || data.chat_completion_source !== identity?.source) return null;
            return frontendOrderReceipt(plan, data.messages, salt, ++frontendSequence);
        },
        confirmFrontendRequest(token, receipt, { responseOk = false } = {}) {
            if (!responseOk || !receipt) { cancelRequest(token, 'frontend-unverified'); return false; }
            return acceptReceipt(token, receipt);
        },
        async confirmRequest(token, { prepared, serverClient, responseOk = false } = {}) {
            const item = pending.get(token);
            if (!item) return false;
            if (!responseOk) { cancelRequest(token); return false; }
            if (prepared?.worldInfoOrderReceipts !== true) { cancelRequest(token, 'server-unavailable'); return false; }
            if (!prepared?.usageId || typeof serverClient?.readUsage !== 'function') { cancelRequest(token, 'recording-unavailable'); return false; }
            for (let attempt = 0; attempt < receiptAttempts; attempt++) {
                if (destroyed || !enabled() || pending.get(token) !== item || item.scope !== scope()) { pending.delete(token); return false; }
                try {
                    const response = await serverClient.readUsage(item.chatId, { includeRequestPreviews: true,
                        ...(prepared.usageLookup === true ? { ids: [prepared.usageId] } : { latest: 12 }) });
                    if (destroyed || pending.get(token) !== item || item.scope !== scope()) return false;
                    const record = response?.records?.find(record => record.id === prepared.usageId && record.chatId === item.chatId);
                    const receipt = record?.googleRequests?.flatMap(request => [request.worldInfoOrder, request.latestWorldInfoOrder])
                        .filter(value => value?.token === token).sort((a, b) => b.sequence - a.sequence)[0];
                    if (receipt) {
                        return acceptReceipt(token, receipt);
                    }
                } catch { /* Read-only retry, never interrupt or repeat generation. */ }
                if (attempt + 1 < receiptAttempts) await sleep(receiptDelayMs);
            }
            cancelRequest(token, 'receipt-unavailable'); return false;
        },
        async confirmNativeRequest(token, { ticket, serverClient } = {}) {
            try {
                const item = pending.get(token);
                if (!item || !ticket || typeof serverClient?.readNativeOrder !== 'function') { cancelRequest(token, 'server-unavailable'); return false; }
                for (let attempt = 0; attempt < receiptAttempts; attempt++) {
                    if (destroyed || !enabled() || pending.get(token) !== item || item.scope !== scope()) { pending.delete(token); return false; }
                    try {
                        const response = await serverClient.readNativeOrder(ticket);
                        if (response?.receipt) return acceptReceipt(token, response.receipt);
                    } catch { /* Read-only receipt retry only. */ }
                    if (attempt + 1 < receiptAttempts) await sleep(receiptDelayMs);
                }
                cancelRequest(token, 'receipt-unavailable'); return false;
            } finally { if (ticket) try { await serverClient?.cancelNativeOrder?.(ticket); } catch { /* Best-effort transient cleanup. */ } }
        },
        setEnabled(value) {
            if (destroyed || !supported) return false;
            const current = getContext();
            if (!current?.extensionSettings || typeof current.saveSettingsDebounced !== 'function') return false;
            const stored = current.extensionSettings[WORLDINFO_STABILITY_SETTINGS_KEY];
            const settings = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
            current.extensionSettings[WORLDINFO_STABILITY_SETTINGS_KEY] = { ...settings, enabled: value === true };
            current.saveSettingsDebounced(); generation = null; histories.clear(); clearDraft(); return true;
        },
        destroy() {
            destroyed = true; for (const [name, handler] of listeners) source.removeListener(name, handler);
            for (const record of timers) { clearTimeout(record.timer); record.resolve(); } timers.clear();
            histories.clear(); pending.clear(); candidate = null; lastScan = null; lastConfirmation = null; generation = null;
        },
    };
}
