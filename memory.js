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
