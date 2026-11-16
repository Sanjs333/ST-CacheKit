/* Body-free request comparison; SPDX-License-Identifier: MPL-2.0 */
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const same = (left, right) => !!left?.fingerprint && left.role === right?.role && left.fingerprint === right.fingerprint;

export function projectCacheBoundary(value) {
    if (value?.version !== 1 || !['split', 'already-separated'].includes(value.status)
        || count(value.historyMessageIndex) === null || value.historyMessageIndex > 511
        || count(value.block) === null || value.block < 1 || value.block > 513
        || count(value.part) === null || value.part < 1 || value.part > 8192
        || count(value.stableTextChars) === null || value.stableTextChars > 2 * 1024 * 1024
        || typeof value.stableFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.stableFingerprint)) return null;
    return { version: 1, status: value.status, historyMessageIndex: value.historyMessageIndex,
        block: value.block, part: value.part, stableTextChars: value.stableTextChars, stableFingerprint: value.stableFingerprint };
}

export function projectRequestComparison(value) {
    if (value?.version !== 1 || value.status !== 'compared' || typeof value.previousId !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(value.previousId)
        || count(value.commonTextChars) === null || value.commonTextChars > 2 * 1024 * 1024
        || count(value.systemTextPrefixChars) === null || value.systemTextPrefixChars > value.commonTextChars) return null;
    let firstDifference = null;
    if (value.firstDifference != null) {
        const difference = value.firstDifference;
        if (!['contents', 'systemInstruction'].includes(difference.field)
            || !['text', 'role', 'structure'].includes(difference.kind)
            || difference.field === 'contents' && (!Number.isSafeInteger(difference.block) || difference.block < 1 || difference.block > 513)
            || difference.field === 'systemInstruction' && difference.block !== null
            || difference.part !== null && (!Number.isSafeInteger(difference.part) || difference.part < 1 || difference.part > 4097)
            || difference.offset !== null && (count(difference.offset) === null || difference.offset > 2 * 1024 * 1024)
            || difference.kind === 'text' && (difference.offset === null || difference.part === null)) return null;
        firstDifference = { field: difference.field, block: difference.block, part: difference.part,
            offset: difference.offset, kind: difference.kind };
    }
    const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
    const hint = value.sourceHint;
    const sourceHint = hint?.kind === 'worldinfo' && safeId(hint.groupId) && safeId(hint.itemId)
        ? { kind: 'worldinfo', groupId: hint.groupId, itemId: hint.itemId } : null;
    return { version: 1, status: 'compared', previousId: value.previousId, commonTextChars: value.commonTextChars,
        systemTextPrefixChars: value.systemTextPrefixChars, firstDifference, sourceHint };
}

/** Full identical blocks are alignment anchors. Unmatched gaps are never
 * claimed to be deleted chat messages: merging/hiding can both change them. */
export function alignRequestBlocks(current, previous) {
    const left = current.slice(0, 64), right = previous.slice(0, 64);
    const scores = Array.from({ length: right.length + 1 }, () => new Uint8Array(left.length + 1));
    for (let before = right.length - 1; before >= 0; before--) for (let after = left.length - 1; after >= 0; after--) {
        scores[before][after] = same(right[before], left[after]) ? scores[before + 1][after + 1] + 1
            : Math.max(scores[before + 1][after], scores[before][after + 1]);
    }
    const anchors = [];
    let before = 0, after = 0;
    while (before < right.length && after < left.length) {
        if (same(right[before], left[after])) { anchors.push({ previous: before, current: after }); before++; after++; }
        else if (scores[before + 1][after] >= scores[before][after + 1]) before++;
        else after++;
    }
    const changes = [];
    let previousStart = 0, currentStart = 0;
    for (const anchor of [...anchors, { previous: right.length, current: left.length, terminal: true }]) {
        const previousGap = [], currentGap = [];
        for (let index = previousStart; index < anchor.previous; index++) previousGap.push(index);
        for (let index = currentStart; index < anchor.current; index++) currentGap.push(index);
        let paired = 0;
        // Position-based comparison explains length changes without asserting
        // that an old and a new block represent the same original chat message.
        while (paired < Math.min(previousGap.length, currentGap.length)
            && right[previousGap[paired]]?.role === left[currentGap[paired]]?.role) {
            const previousIndex = previousGap[paired], currentIndex = currentGap[paired];
            changes.push({ kind: 'changed', previous: previousIndex + 1, current: currentIndex + 1,
                previousChars: right[previousIndex]?.textChars ?? null, currentChars: left[currentIndex]?.textChars ?? null }); paired++;
        }
        for (const index of previousGap.slice(paired)) changes.push({ kind: 'unmatched-previous', previous: index + 1,
            current: null, previousChars: right[index]?.textChars ?? null, currentChars: null });
        for (const index of currentGap.slice(paired)) changes.push({ kind: 'unmatched-current', previous: null,
            current: index + 1, previousChars: null, currentChars: left[index]?.textChars ?? null });
        if (!anchor.terminal) changes.push({ kind: 'same', previous: anchor.previous + 1, current: anchor.current + 1,
            previousChars: right[anchor.previous]?.textChars ?? null, currentChars: left[anchor.current]?.textChars ?? null });
        previousStart = anchor.previous + 1; currentStart = anchor.current + 1;
    }
    return changes;
}

export function compareRequestPreviews(current, previous) {
    if (!previous) return { status: 'no_previous' };
    const left = current.preview, right = previous.preview;
    if (left.status !== 'available' || right.status !== 'available') return { status: 'unavailable' };
    if (!left.epoch || left.epoch !== right.epoch) return { status: 'different_epoch' };
    if (left.captureKind !== right.captureKind) return { status: 'different_capture' };
    if (['model', 'source', 'region'].some(key => current[key] !== previous[key])) return { status: 'different_scope' };
    const known = value => value.contentCount !== null && value.omittedContents !== null
        && value.contentCount === value.contents.length + value.omittedContents
        && (value.systemInstruction === null || !!value.systemInstruction?.fingerprint)
        && value.contents.every(content => !!content?.fingerprint);
    if (!known(left) || !known(right)) return { status: 'unavailable' };
    const systemUnchanged = left.systemInstruction === null && right.systemInstruction === null
        || same(left.systemInstruction, right.systemInstruction);
    let commonBlocks = 0, commonTextChars = 0;
    if (systemUnchanged) {
        commonTextChars = left.systemInstruction?.textChars ?? 0;
        while (commonBlocks < Math.min(left.contents.length, right.contents.length) && same(left.contents[commonBlocks], right.contents[commonBlocks])) {
            commonTextChars += left.contents[commonBlocks].textChars ?? 0; commonBlocks++;
        }
    }
    const sameBody = !!left.bodyFingerprint && left.bodyFingerprint === right.bodyFingerprint;
    const wireComparison = left.requestComparison?.previousId === previous.id ? left.requestComparison : null;
    const stablePrefix = left.cacheBoundary && right.cacheBoundary ? {
        previousChars: right.cacheBoundary.stableTextChars, currentChars: left.cacheBoundary.stableTextChars,
        unchanged: right.cacheBoundary.stableFingerprint === left.cacheBoundary.stableFingerprint,
    } : null;
    return { status: 'compared', systemUnchanged, commonBlocks, commonTextChars, sameBody,
        firstChangedBlock: systemUnchanged && commonBlocks < Math.min(left.contents.length, right.contents.length) ? commonBlocks + 1 : null,
        prefixUnchanged: sameBody || systemUnchanged && right.omittedContents === 0 && commonBlocks === right.contents.length && left.contentCount >= right.contentCount,
        contentsReduced: left.contentCount < right.contentCount,
        previousContentCount: right.contentCount, currentContentCount: left.contentCount,
        alignment: alignRequestBlocks(left.contents, right.contents), wireComparison, stablePrefix,
        parametersComparable: !!left.parametersFingerprint && !!right.parametersFingerprint,
        sameParameters: !!left.parametersFingerprint && left.parametersFingerprint === right.parametersFingerprint,
        bounded: (left.omittedContents ?? 0) > 0 || (right.omittedContents ?? 0) > 0 };
}
