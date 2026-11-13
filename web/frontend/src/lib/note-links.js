// Link helpers shared by the editor navigation (outline and backlinks).

export function normalizeLinkPath(value) {
    const segments = [];
    for (const segment of String(value ?? '').trim().replace(/\\/g, '/').split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
    }
    return segments.join('/').replace(/\.md$/i, '').toLowerCase();
}

export function linkTargetMatches(rawTarget, target, sourceFolder = '') {
    const raw = String(rawTarget ?? '').trim().replace(/^<|>$/g, '');
    if (!raw) return false;

    const noteID = raw.match(/^\?note=(\d+)/);
    if (noteID) return target.id !== null && target.id !== undefined && Number(noteID[1]) === Number(target.id);

    if (raw.startsWith('#') || raw.startsWith('//') || raw.includes('://')) return false;
    if (raw.startsWith('/api/')) return false;

    const pathTarget = raw.split('#')[0].split('?')[0];
    if (!pathTarget) return false;

    let candidate = pathTarget;
    try {
        candidate = decodeURIComponent(candidate);
    } catch {
        // Keep the raw value when it is not valid percent-encoding.
    }
    candidate = candidate.replace(/\.md$/i, '');

    const title = normalizeLinkPath(target.title || '');
    if (!title) return false;
    const forms = new Set([title]);
    if (target.folder) forms.add(normalizeLinkPath(`${target.folder}/${title}`));

    const absolute = candidate.startsWith('/');
    candidate = candidate.replace(/^\/+/, '');
    const candidates = [candidate];
    if (!absolute && sourceFolder) candidates.unshift(`${sourceFolder}/${candidate}`);

    for (const value of candidates) {
        if (forms.has(normalizeLinkPath(value))) return true;
        // Mirrors the backend fallback that resolves links by note title.
        if (normalizeLinkPath(value.split('/').pop() || '') === title) return true;
    }
    return false;
}

export function findLinkOccurrence(markdown, target, sourceFolder = '') {
    const lines = String(markdown ?? '').split('\n');
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index];
        const fenceMatch = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
            continue;
        }

        // Padding with spaces preserves indices while skipping inline code.
        const line = rawLine.replace(/`+[^`\n]*`+/g, match => ' '.repeat(match.length));
        for (const match of line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
            if (!linkTargetMatches(match[1], target, sourceFolder)) continue;
            return { line: index, index: match.index, length: match[0].length };
        }
        for (const match of line.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
            if (!linkTargetMatches(match[1].replace(/^<|>$/g, ''), target, sourceFolder)) continue;
            return { line: index, index: match.index, length: match[0].length };
        }
        const definition = line.match(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/);
        if (definition && linkTargetMatches(definition[1].replace(/^<|>$/g, ''), target, sourceFolder)) {
            return { line: index, index: definition.index, length: definition[0].length };
        }
    }
    return null;
}
