/* Evidence-based local cache analysis; SPDX-License-Identifier: MPL-2.0 */
import { cacheMinimumInputTokens } from './cache-diagnostics-policy.js';
import { formatCacheHitRate } from './cost-model.js';

const number = value => value.toLocaleString('zh-CN');
const rate = formatCacheHitRate;
const SCOPE_LABELS = { model: '模型', source: '来源', region: '区域' };
const ERROR_FINDINGS = Object.freeze({
    VERTEX_UPSTREAM_TIMEOUT: ['request_timeout', '上游请求超时', '后端记录了等待 Google 响应超时。'],
    NATIVE_RELAY_UPSTREAM_TIMEOUT: ['request_timeout', '上游请求超时', '后端记录了上游请求超时。'],
    UPSTREAM_HTTP_408: ['request_timeout', '上游返回 HTTP 408', '上游报告请求超时。'],
    UPSTREAM_HTTP_504: ['request_timeout', '上游返回 HTTP 504', '上游报告网关超时。'],
    USAGE_CAPTURE_TIMEOUT: ['capture_timeout', '用量记录等待超时', '用量记录长时间未完成；这不能确认 Google 请求或缓存是否超时。'],
    PROCESS_RESTARTED: ['process_restarted', '后端重启后记录未完成', '请求的用量记录因后端重启而中断。'],
    CLIENT_DISCONNECTED: ['client_disconnected', '客户端连接中断', '生成连接中途断开，用量可能不完整。'],
    CLIENT_ABORTED: ['client_disconnected', '请求被取消', '生成中途取消，用量可能不完整。'],
    USAGE_METADATA_MISSING: ['usage_missing', '没有收到用量数据', '响应没有可用的用量信息，无法判断缓存命中。'],
    USAGE_CAPTURE_LIMIT: ['capture_limit', '用量采集不完整', '响应超出用量采集上限，无法可靠判断缓存命中。'],
    USAGE_COMPRESSED_RESPONSE: ['capture_unavailable', '无法采集压缩响应的用量', '当前采集器无法读取这条压缩响应的用量。'],
});

export const sameCacheScope = (left, right) => !!right && ['model', 'source', 'region'].every(key => left[key] === right[key]);
const multipleRequests = value => value?.googleRequestCount > 1 || value?.storedRequestCount > 1;

function referenceView(current, reference) {
    if (!reference) return null;
    const elapsed = Date.parse(current.createdAt) - Date.parse(reference.createdAt);
    return { id: reference.id, createdAt: reference.createdAt, cacheRate: reference.usage.cacheRate,
        elapsedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null };
}

function addObservedChanges(add, current, previous, reference, comparison) {
    const changedScope = previous ? Object.keys(SCOPE_LABELS).filter(key => current[key] !== previous[key]) : [];
    if (changedScope.length) add('scope_changed', 'observed', `${changedScope.map(key => SCOPE_LABELS[key]).join('、')}发生变化`,
        '与上一条记录的请求范围不同，不能直接比较其缓存复用。');
    if (previous && current.tier !== previous.tier) add('tier_changed', 'observed', '请求层级发生变化', '与上一条记录使用的服务层级不同。');
    if (!reference || comparison.status !== 'compared') return;
    if (comparison.stablePrefix) add('stable_prefix_boundary', 'observed', comparison.stablePrefix.unchanged ? '独立稳定区保持相同' : '独立稳定区发生变化',
        `依据历史来源分界比较，参考请求 ${number(comparison.stablePrefix.previousChars)} 字符 → 本轮 ${number(comparison.stablePrefix.currentChars)} 字符；稳定区内容与角色结构${comparison.stablePrefix.unchanged ? '一致' : '不同'}。`);
    if (!comparison.systemUnchanged) add('system_changed', 'observed', '系统指令发生变化',
        '系统指令的内容或结构与参考请求不同，或者系统指令被新增、移除。');
    else if (comparison.firstChangedBlock !== null) add('message_changed', 'observed',
        comparison.firstChangedBlock === 1 ? '第一块对话内容发生变化' : '对话消息块发生变化',
        `第 ${comparison.firstChangedBlock} 块与参考请求不同，此前 ${comparison.commonBlocks} 个完整消息块相同。整块指纹不同不代表块内没有相同文本前缀。`);
    else if (comparison.prefixUnchanged) add('prefix_unchanged', 'observed', '参考请求的完整消息前缀保持一致',
        `系统指令与参考请求的完整消息块保持一致，共 ${number(comparison.commonTextChars)} 个文本字符。`);
    if (comparison.previousContentCount !== comparison.currentContentCount) add('message_count_changed', 'observed', '对话消息块数量变化',
        `参考请求 ${comparison.previousContentCount} 块 → 本轮 ${comparison.currentContentCount} 块。隐藏、移除或合并都可能改变块数，来源需要额外证据。`);
    const exact = comparison.wireComparison;
    if (exact) {
        add('exact_text_prefix', 'observed', '已比较实际发送的文本前缀',
            `在相同角色与部件结构下，开头 ${number(exact.commonTextChars)} 个文本字符一致；系统指令中一致的前缀为 ${number(exact.systemTextPrefixChars)} 个字符。字符数不是缓存 token 数。`);
        const difference = exact.firstDifference;
        if (difference) {
            const location = difference.field === 'systemInstruction' ? '系统指令' : `第 ${difference.block} 个对话消息块`;
            add('first_wire_difference', 'observed', '第一处发送内容差异',
                difference.kind === 'text' ? `${location}，第 ${difference.part} 个文本部件，文本位置 ${number(difference.offset + 1)}。`
                    : `${location}${difference.part ? `，第 ${difference.part} 个部件` : ''}的${difference.kind === 'role' ? '角色' : '结构或非文本内容'}变化。`);
            if (exact.sourceHint?.kind === 'worldinfo') add('difference_worldinfo_source', 'observed', '差异位置落在已确认的世界书条目中',
                `来源组 ID：${exact.sourceHint.groupId}；条目 ID：${exact.sourceHint.itemId}。`);
            else add('difference_source_unknown', 'unknown', '差异来源尚未定位',
                '已记录差异所在的发送字段和位置，但没有可验证的预设、历史或世界书来源映射。');
        }
    } else if (!comparison.sameBody && comparison.firstChangedBlock !== null) add('text_location_unavailable', 'unknown', '暂无块内逐字差异记录',
        '当前记录只能比较整块指纹。新请求在同一后端进程中、五分钟内有同范围的成功参考请求时，会保留差异位置；提示词正文不写入账本。');
    if (comparison.parametersComparable && !comparison.sameParameters) add('parameters_changed', 'observed', '其他请求参数发生变化',
        '工具、生成配置、思考设置或其他非消息参数的指纹不同。');
}

export function buildCacheMissAnalysis(current, { previous = null, reference = null, comparison = { status: 'no_previous' } } = {}) {
    const findings = [];
    const add = (code, confidence, title, detail, advice = '') => findings.push({ code, confidence, title, detail, advice });
    const result = { outcome: 'unknown', summary: '', reference: referenceView(current, reference), findings, note: '' };
    const { usage } = current;
    addObservedChanges(add, current, previous, reference, comparison);
    if (current.status === 'pending') {
        result.outcome = 'pending'; result.summary = '请求仍在生成，等待完整用量后再判断缓存命中。';
        return result;
    }
    if (usage.partial) {
        result.outcome = 'incomplete'; result.summary = current.status === 'complete'
            ? '响应已完成，但部分用量字段无效，无法作出可靠的缓存结论。'
            : '请求未成功完成，当前用量不足以确定缓存未命中的原因。';
        const error = Object.hasOwn(ERROR_FINDINGS, current.errorCode) ? ERROR_FINDINGS[current.errorCode] : null;
        if (error) add(error[0], 'observed', error[1], error[2]);
        else if (current.status === 'complete') add('usage_invalid', 'observed', '检测到无效用量字段', '后端采集器标记了用量字段异常。');
        else add('request_incomplete', 'observed', current.status === 'failed' ? '请求失败' : '请求未完成',
            current.errorCode ? `记录中的错误码：${current.errorCode}。` : '记录未包含具体的错误原因。');
        result.note = '请求超时、连接中断和用量采集失败描述的是请求过程；缓存的实际到期时间需要上游提供。';
        return result;
    }
    if (usage.cacheRate === null) {
        result.summary = '缓存命中未知，不能把缺失或无效的缓存数据当成 0% 未命中。';
        if (usage.cacheField === 'mixed') add('cache_count_mixed', 'unknown', '子请求的缓存计数不完整',
            '部分 Google 子请求返回了缓存计数，部分没有返回，无法计算可靠的汇总命中率。');
        else if (usage.cacheField === 'invalid') add('cache_count_invalid', 'observed', '缓存用量无效',
            '缓存计数或输入计数无效，或者缓存计数大于输入计数。');
        else if (usage.promptTokens === 0) add('empty_input', 'observed', '输入 token 数为 0', '没有有效的输入量可用于计算命中比例。');
        else add('cache_count_missing', 'observed', '没有可用的缓存计数',
            usage.cacheField === 'omitted' ? 'Google 没有返回缓存计数字段；后端为费用估算补齐的 0 不能证明实际返回了 0。'
                : '记录缺少缓存计数或输入计数，无法判断是否实际未命中。');
        result.note = '请求变化与缓存计数分别展示；已检测到的变化不能单独证明缓存未命中。';
        return result;
    }
    if (usage.cacheRate > 0) {
        result.outcome = 'hit'; result.summary = `本轮有缓存命中：${number(usage.cachedTokens)} tokens，占输入的 ${rate(usage.cacheRate)}。`;
        if (usage.cacheRate < 0.001) add('rate_rounding', 'observed', '命中率很低，可能被显示精度舍入为 0%',
            `记录实际包含 ${number(usage.cachedTokens)} 个缓存 tokens；这里以 <0.1% 显示，保留已命中的区别。`);
        return result;
    }

    result.outcome = ['unverified', 'normalized'].includes(usage.cacheField) ? 'unknown' : 'miss';
    result.summary = usage.cacheField === 'unverified'
        ? '记录显示 0%；旧记录没有保留缓存计数的来源，以下分析仅供排查。'
        : usage.cacheField === 'normalized' ? 'TT 兼容格式的用量显示 0%；以下分析仅供排查。'
            : usage.cacheField === 'default-zero' ? '完整的 Google 官方响应省略了缓存零值，按协议默认值记录为 0%。'
            : 'Google 返回的缓存计数为 0。以下列出检测到的变化和可能原因。';
    result.note = 'Google 未返回具体的未命中原因或隐式缓存的实际到期时间。请求间隔只能作为线索，无法据此确认缓存过期。';
    if (usage.cacheField === 'unverified') add('legacy_zero', 'unknown', '旧记录中的 0 可能是补齐值',
        '旧版本可能将缺失或兼容格式的缓存计数记为 0，无法事后确认原始字段；新版插件会为新请求保留计数来源。');
    if (usage.cacheField === 'normalized') add('normalized_usage', 'unknown', '用量经过兼容格式转换',
        'TT 渠道的兼容用量可能省略上游字段来源，无法确认该 0 是否由 Google 明确返回。');
    if (current.preview.captureKind === 'tauri-frontend') {
        result.note += ' 结构摘要来自 TT 前端发送给宿主的请求，宿主可能继续转换提示词；前端变化只能作为上游缓存的排查线索。';
    }

    const currentAggregate = multipleRequests(current);
    const aggregate = currentAggregate || multipleRequests(reference);
    if (aggregate) add('aggregate_usage', 'unknown', '用量由多个 Google 子请求汇总',
        '结构摘要只展示首个子请求，不能将汇总的 0% 归因于某一个子请求或检查单次输入门槛。');
    const minimum = cacheMinimumInputTokens(current.source, current.model);
    const belowMinimum = !currentAggregate && current.preview.status === 'available' && !current.preview.hasExplicitCache
        && current.preview.cacheMode !== 'unknown'
        && minimum !== null && usage.promptTokens < minimum;
    if (belowMinimum) add('below_minimum', 'observed', '输入量低于隐式缓存门槛',
        `本轮输入 ${number(usage.promptTokens)} tokens，低于该来源与模型公布的 ${number(minimum)} tokens 门槛。`,
        '短提示词可能无法触发隐式缓存；固定内容应放在提示词开头，且共同前缀本身也需要足够长。');

    if (!reference) {
        if (current.preview.hasExplicitCache) add('explicit_cache_unconfirmed', 'unknown', '显式缓存状态需要上游确认',
            '请求引用了显式缓存，但本地摘要没有缓存资源的有效期，无法确认资源是否过期。');
        else add('no_reference', 'possible', '可能尚未建立可复用的缓存',
            '当前聊天最近的记录中，没有同模型、来源和区域的成功请求可作参考；这不能证明是首次请求。',
            '完成一次请求后，在短时间内继续发送具有相同开头内容的请求。');
    } else if (comparison.status === 'compared') {
        if (!aggregate && !belowMinimum && (comparison.sameBody || comparison.prefixUnchanged)) {
            if (current.preview.hasExplicitCache) add('explicit_cache_unconfirmed', 'unknown', '显式缓存状态需要上游确认',
                '请求引用了显式缓存，但本地摘要没有缓存资源的有效期，无法确认资源是否过期。');
            else add('cache_unavailable', 'possible', '可能缓存过期、被回收或服务端未复用',
                `${reference.usage.cacheRate > 0 ? `参考请求曾命中 ${rate(reference.usage.cacheRate)}，本轮已记录的历史前缀仍相同。` : '已记录的历史前缀相同，但没有证据证明服务端已有可复用缓存。'}隐式缓存不保证命中；账号、项目或服务端路由变化也可能影响复用。`,
                '保持固定前缀，在短时间内再观察一次请求；如持续为 0，检查账号或项目的缓存设置。');
        }
    } else {
        add('comparison_unavailable', 'unknown', '无法核对参考请求的前缀',
            comparison.status === 'different_epoch' ? '指纹密钥变化或缺失，常见于后端重启；无法进行跨密钥比较。'
                : '当前或参考请求缺少完整的结构指纹，无法判断是否因提示词变化而未命中。');
        if (!belowMinimum && !aggregate) add('cache_conditions_unknown', 'possible', '隐式缓存条件或服务端缓存状态仍需排查',
            '可能是共同前缀不足、缓存尚未建立、过期或被回收；现有记录无法区分这些情况。');
    }
    return result;
}
