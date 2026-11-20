// Message indices are inclusive throughout the memory store.
export function selectPendingTurns(visible, cursor, retained) {
    const boundary = Math.max(0, visible.length - retained);
    return visible.slice(0, boundary).filter(turn => turn.index > cursor);
}

export function sourceRanges(snippet) {
    if (snippet.sourceRanges) return snippet.sourceRanges;
    return snippet.turnRange ? [snippet.turnRange] : [];
}

export function coverage(snippets) {
    const ranges = snippets.flatMap(sourceRanges).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of ranges) {
        const previous = merged.at(-1);
        if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

// Validate before touching the current memory or its visibility state. Only copy
// known fields; imported indices never establish ownership of hidden messages.
export function validateMemoryImport(data, chatLength) {
    const invalid = () => { throw new Error('记忆文件格式无效，或消息索引不属于当前聊天。'); };
    const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
        Number.isSafeInteger(value) && value >= min && value <= max;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.layers)) invalid();
    if (data.layers.length > 100) invalid();
    let count = 0;
    const layers = data.layers.map(layer => {
        if (!Array.isArray(layer)) invalid();
        count += layer.length;
        if (count > 100000) invalid();
        return layer.map(snippet => {
            if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet) || typeof snippet.text !== 'string') invalid();
            const copy = { text: snippet.text };
            if (Object.hasOwn(snippet, 'turnRange')) {
                const range = snippet.turnRange;
                if (!Array.isArray(range) || range.length !== 2
                    || !integer(range[0], 0, chatLength - 1)
                    || !integer(range[1], range[0], chatLength - 1)) invalid();
                copy.turnRange = [...range];
            }
            if (Object.hasOwn(snippet, 'sourceRanges')) {
                if (!Array.isArray(snippet.sourceRanges) || copy.turnRange) invalid();
                copy.sourceRanges = snippet.sourceRanges.map(range => {
                    if (!Array.isArray(range) || range.length !== 2
                        || !integer(range[0], 0, chatLength - 1)
                        || !integer(range[1], range[0], chatLength - 1)) invalid();
                    return [...range];
                });
            }
            for (const key of ['timestamp', 'fromLayer', 'seedFromLayer', 'mergedCount']) {
                if (Object.hasOwn(snippet, key)) {
                    if (!integer(snippet[key], key === 'mergedCount' ? 1 : 0)) invalid();
                    copy[key] = snippet[key];
                }
            }
            for (const key of ['promoted', 'regenerated']) {
                if (Object.hasOwn(snippet, key)) {
                    if (typeof snippet[key] !== 'boolean') invalid();
                    copy[key] = snippet[key];
                }
            }
            return copy;
        });
    });
    const summarizedUpTo = data.summarizedUpTo ?? -1;
    if (!integer(summarizedUpTo, -1, chatLength - 1)) invalid();
    if (Object.hasOwn(data, 'ghostedIndices') && (!Array.isArray(data.ghostedIndices)
        || data.ghostedIndices.some(index => !integer(index, 0, chatLength - 1)))) invalid();
    return { layers, summarizedUpTo, ghostedIndices: [] };
}
