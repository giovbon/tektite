import test from 'node:test';
import assert from 'node:assert/strict';
import { findLinkOccurrence, linkTargetMatches, normalizeLinkPath } from './note-links.js';

const target = { id: 7, title: 'Nota Alvo', folder: 'Projetos' };

test('normalizes note paths like the backend link index', () => {
    assert.equal(normalizeLinkPath(' Projetos\\Sub/../Nota Alvo.md '), 'projetos/nota alvo');
    assert.equal(normalizeLinkPath('/Projetos/./Nota Alvo'), 'projetos/nota alvo');
});

test('matches wikilink and markdown targets by title, path and id', () => {
    assert.equal(linkTargetMatches('Nota Alvo', target), true);
    assert.equal(linkTargetMatches('Nota Alvo.md', target), true);
    assert.equal(linkTargetMatches('Projetos/Nota Alvo', target), true);
    assert.equal(linkTargetMatches('/Projetos/Nota Alvo.md', target), true);
    assert.equal(linkTargetMatches('../Projetos/Nota Alvo', target, 'Diario'), true);
    assert.equal(linkTargetMatches('?note=7', target), true);
});

test('rejects links that point elsewhere', () => {
    assert.equal(linkTargetMatches('?note=8', target), false);
    assert.equal(linkTargetMatches('#secao', target), false);
    assert.equal(linkTargetMatches('https://example.com/Nota Alvo', target), false);
    assert.equal(linkTargetMatches('/api/notes/7/attachments/1', target), false);
    assert.equal(linkTargetMatches('Outra Nota', target), false);
});

test('honors titles containing colons', () => {
    assert.equal(linkTargetMatches('261112 19:42', { id: 9, title: '261112 19:42', folder: '' }), true);
});

test('finds the first real link occurrence and skips code', () => {
    const markdown = [
        '# Diario',
        '',
        '`[[Nota Alvo]]` não conta',
        '',
        '```md',
        '[[Nota Alvo]]',
        '```',
        '',
        'Veja [[Nota Alvo|alias]] agora.',
        '',
        '[link](Projetos/Nota%20Alvo.md#topo)'
    ].join('\n');
    assert.deepEqual(findLinkOccurrence(markdown, target), {
        line: 8,
        index: 5,
        length: 19
    });
    assert.equal(findLinkOccurrence('nada aqui', target), null);
});

test('finds links written as reference definitions', () => {
    const markdown = 'Texto\n\n[alvo]: <Projetos/Nota Alvo.md> "título"';
    assert.equal(findLinkOccurrence(markdown, target).line, 2);
});
