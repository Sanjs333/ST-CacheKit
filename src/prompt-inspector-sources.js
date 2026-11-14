/* Friendly labels/classification for captured evidence; never expands macros or changes sent text.
 * SPDX-License-Identifier: MPL-2.0 */
const labels = new Map([
    ['main', '主提示词'], ['nsfw', '内容提示词'], ['jailbreak', '后置提示词'], ['enhanceDefinitions', '角色补充'],
    ['charDescription', '角色描述'], ['charPersonality', '角色性格'], ['scenario', '场景设定'],
    ['personaDescription', '用户设定'], ['persona', '用户设定'], ['authorsNote', '作者注释'],
    ['chatHistory', '聊天历史'], ['dialogueExamples', '角色示例对话'], ['impersonate', '代写用户提示'],
    ['groupNudge', '群聊发言提示'], ['quietPrompt', '后台生成提示'], ['bias', '助手预填充'],
    ['newChat', '新聊天提示'], ['newMainChat', '新聊天提示'], ['continueNudge', '续写提示'],
    ['summary', '聊天摘要'], ['vectorsMemory', '历史检索'], ['vectorsDataBank', '资料检索'], ['smartContext', '智能上下文'],
]);
const internalControls = new Set(['impersonate', 'groupNudge', 'quietPrompt', 'bias']);
const defaultLabels = new Set(['Main Prompt', 'NSFW Prompt', 'Jailbreak Prompt', 'Auxiliary Prompt',
    'Enhance Definitions', 'Char Description', 'Char Personality', 'Scenario', 'Persona Description',
    'Chat History', 'Dialogue Examples', 'World Info (before)', 'World Info (after)']);
const text = value => typeof value === 'string' ? value : '';
export const promptIdentifier = source => text(source?.identifier)
    || (text(source?.id).startsWith('prompt:') ? source.id.slice(7) : '');
function historyNumber(source) {
    // Native chatHistory-N identifiers also name aggregated depth injections.
    // An explicitly identified extension/input is not a history item.
    if (source?.kind && !['history', 'unknown', 'preset'].includes(source.kind)) return null;
    const identifier = promptIdentifier(source), id = text(source?.id);
    const prompt = /^chatHistory-([1-9]\d*)$/u.exec(identifier);
    if (prompt && Number.isSafeInteger(Number(prompt[1]))) return Number(prompt[1]);
    const conversation = /^conversation:(\d+)$/u.exec(id);
    if (conversation && Number.isSafeInteger(Number(conversation[1])) && Number(conversation[1]) < Number.MAX_SAFE_INTEGER) return Number(conversation[1]) + 1;
    return null;
}
export function canonicalHistoryId(source) {
    const number = historyNumber(source); return number === null ? null : 'conversation:' + (number - 1);
}
export const isInternalControlSource = source => internalControls.has(promptIdentifier(source));
export function describePromptSource(source) {
    const identifier = promptIdentifier(source), number = historyNumber(source);
    let kind = source?.kind ?? 'unknown';
    if (number !== null || identifier === 'chatHistory') kind = 'history';
    else if (['charDescription', 'charPersonality', 'scenario', 'dialogueExamples'].includes(identifier)) kind = 'character';
    else if (['personaDescription', 'persona'].includes(identifier)) kind = 'persona';
    else if (identifier === 'authorsNote') kind = 'author-note';
    else if (internalControls.has(identifier)) kind = 'extension';
    else if (['summary', 'vectorsMemory', 'smartContext'].includes(identifier)) kind = 'memory';
    const original = text(source?.label).trim();
    const fallback = kind === 'persona' ? '用户设定' : kind === 'character' ? '角色资料'
        : kind === 'history' ? '聊天消息' : kind === 'preset' ? '预设条目' : kind === 'extension' ? '扩展内容' : '来源待确认';
    const isPlaceholder = /^\s*\{\{(?:user|char)\}\}\s*$/iu.test(original);
    const generic = !original || original === identifier || original === source?.id || defaultLabels.has(original) || isPlaceholder;
    return { kind, label: number !== null ? `第 ${number} 条聊天消息`
        : generic || internalControls.has(identifier) ? labels.get(identifier) ?? fallback : original };
}

/** Merge only duplicate capture of one identified history item, not independent same-text sources. */
export function normalizePromptSources(sources) {
    const ids = new Map(), native = new Map();
    for (const source of sources) if (source && typeof source.id === 'string') ids.set(source.id, (ids.get(source.id) ?? 0) + 1);
    for (const source of sources) {
        const canonical = canonicalHistoryId(source);
        if (canonical && source?.id === canonical && ids.get(canonical) === 1 && typeof source.text === 'string') native.set(canonical, source);
    }
    return sources.filter(source => {
        const canonical = canonicalHistoryId(source), existing = canonical && native.get(canonical);
        return !(existing && source.id !== canonical && ids.get(source.id) === 1
            && existing.text === source.text && existing.role === source.role);
    }).map(source => source && typeof source === 'object' && !Array.isArray(source)
        ? { ...source, ...describePromptSource(source) } : source);
}
