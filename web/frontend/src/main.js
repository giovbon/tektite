import { requestJSON } from './lib/api-client.js';
import { CommandPalette } from './lib/command-palette.js';
import { ensureFrontmatterTags, extractMarkdownOutline, frontmatterLineOffset, highlightMarkdown, MarkdownEditor, parseFrontmatter, stripFrontmatter } from './lib/markdown-editor.js';
import { GraphView } from './lib/graph-view.js';
import { findLinkOccurrence, linkTargetMatches, normalizeLinkPath } from './lib/note-links.js';
import { highlightCode } from './lib/syntax-highlight.js';
import { getScrollSpacerHeight, mapEditorToPreview, mapPreviewToEditor } from './lib/scroll-sync.js';

const pageSize = 30;
const treePageSize = 100;
const state = {
    mode: 'title',
    folder: '',
    tag: '',
    tags: [],
    offset: 0,
    total: 0,
    notes: [],
    folders: [],
    folderNotes: new Map(),
    folderNotesLoading: new Set(),
    folderNotesGeneration: 0,
    expandedFolders: new Set(['']),
    view: 'list',
    graphVisible: false,
    graphData: null,
    graphRequestID: 0,
    backlinks: null,
    backlinksError: '',
    backlinksRequestID: 0,
    outline: [],
    pendingOutlineLine: null,
    pendingBacklink: null,
    noteID: null,
    noteFolder: '',
    noteVersion: null,
    frontmatterExpanded: false,
    savedDraft: null,
    listState: null,
    directEntry: false,
    requestID: 0,
    navigationID: 0,
    searchTimer: null,
    saveTimer: null,
    savePromise: null,
    notesLoaded: false,
    tableData: [],
    table: null,
    tableRequestID: 0,
    tableKey: '',
    tableLoaded: false,
    tableColumnCount: 0,
    wikilinkRequestID: 0,
    wikilinkTimer: null,
    wikilinkHeadingCache: new Map(),
    wikilinkAutocomplete: {
        open: false,
        items: [],
        activeIndex: 0,
        mode: 'note'
    }
};
let editorSplitPercent = 50;
let workspacePanelWidth = 280;

const elements = {
    searchView: document.querySelector('#searchView'),
    graphView: document.querySelector('#graphView'),
    editorView: document.querySelector('#editorView'),
    searchInput: document.querySelector('#searchInput'),
    resultsSection: document.querySelector('#resultsSection'),
    tableView: document.querySelector('#tableView'),
    notesTable: document.querySelector('#notesTable'),
    tableSummary: document.querySelector('#tableSummary'),
    tableColumnsInfo: document.querySelector('#tableColumnsInfo'),
    tableFooterInfo: document.querySelector('#tableFooterInfo'),
    notesList: document.querySelector('#notesList'),
    resultCount: document.querySelector('#resultCount'),
    resultsTitle: document.querySelector('#resultsTitle'),
    tagFilterBar: document.querySelector('#tagFilterBar'),
    clearTag: document.querySelector('#clearTag'),
    clearFolder: document.querySelector('#clearFolder'),
    pagination: document.querySelector('#pagination'),
    pageStatus: document.querySelector('#pageStatus'),
    previousPage: document.querySelector('#previousPage'),
    nextPage: document.querySelector('#nextPage'),
    panel: document.querySelector('#workspacePanel'),
    panelResizer: document.querySelector('#workspacePanelResizer'),
    panelTitle: document.querySelector('#panelTitle'),
    panelContent: document.querySelector('#panelContent'),
    backlinksCount: document.querySelector('#backlinksCount'),
    outlineCount: document.querySelector('#outlineCount'),
    currentFolder: document.querySelector('#currentFolder'),
    noteTitle: document.querySelector('#noteTitle'),
    noteContent: document.querySelector('#noteContent'),
    noteContentHighlight: document.querySelector('#noteContentHighlight'),
    markdownPreview: document.querySelector('#markdownPreview'),
    wikilinkAutocomplete: document.querySelector('#wikilinkAutocomplete'),
    attachmentsDialog: document.querySelector('#attachmentsDialog'),
    attachmentsButton: document.querySelector('#attachmentsButton'),
    attachmentInput: document.querySelector('#attachmentInput'),
    attachmentList: document.querySelector('#attachmentList'),
    attachmentsEmpty: document.querySelector('#attachmentsEmpty'),
    editorWorkspace: document.querySelector('.editor-workspace'),
    saveStatus: document.querySelector('#saveStatus'),
    appMessage: document.querySelector('#appMessage'),
    newNote: document.querySelector('#newNote'),
    deleteCurrentNote: document.querySelector('#deleteCurrentNote'),
    backupInput: document.querySelector('#backupInput')
};

function syncMarkdownHighlight() {
    elements.noteContentHighlight.innerHTML = `${highlightMarkdown(elements.noteContent.value)}\n`;
    elements.noteContentHighlight.scrollTop = elements.noteContent.scrollTop;
    elements.noteContentHighlight.scrollLeft = elements.noteContent.scrollLeft;
}

function highlightPreviewCode() {
    for (const code of elements.markdownPreview.querySelectorAll('pre > code')) {
        const languageClass = [...code.classList].find(name => name.startsWith('language-'));
        const language = languageClass?.slice('language-'.length) || '';
        const safeLanguage = /^[\w+-]{1,30}$/.test(language) ? language : '';
        const pre = code.parentElement;
        if (safeLanguage) pre.dataset.language = safeLanguage;
        else delete pre.dataset.language;
        code.innerHTML = highlightCode(code.textContent, safeLanguage);
    }
}

let previewTimer;
let previewRequestID = 0;
let renderedPreviewMarkdown = '';
let editorLinePositionCache = null;
let scrollSyncFrame = 0;
let pendingScrollSource = null;
let programmaticScroll = null;
let scrollSyncSuspendedUntil = 0;
const markdownEditor = new MarkdownEditor(elements.noteContent, () => {
    syncMarkdownHighlight();
    syncPreviewMinimumHeight();
    updatePreview();
    scheduleSave();
    refreshOutline();
}, updateEditorHistoryButtons);
syncMarkdownHighlight();
const graphView = new GraphView(document.querySelector('#noteGraph'), id => void openNote(id));
const commandPalette = new CommandPalette({
    dialog: document.querySelector('#commandPalette'),
    input: document.querySelector('#commandInput'),
    list: document.querySelector('#commandList'),
    loadNotes: loadCommandNotes,
    getCommands: buildCommandItems,
    onNote: note => void openNote(note.id),
    onError: error => showMessage(`Não foi possível executar o comando: ${error.message}`, 'error')
});
document.querySelector('#graphButton').addEventListener('click', () => {
    void openGraphView().catch(error => {
        showMessage(`Não foi possível abrir o grafo: ${error.message}`, 'error');
    });
});

document.addEventListener('DOMContentLoaded', () => void initialize());

function startSplitResize(event) {
    if (event.button !== 0 || !window.matchMedia('(min-width: 701px)').matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-editor');
    resizeSplit(event);
}

function resizeSplit(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    const bounds = elements.editorWorkspace.getBoundingClientRect();
    if (!bounds.width) return;
    editorSplitPercent = Math.min(80, Math.max(20, ((event.clientX - bounds.left) / bounds.width) * 100));
    updateSplitRatio();
    syncPreviewMinimumHeight();
    syncEditorScrollFromSource();
}

function stopSplitResize(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('is-resizing-editor');
    localStorage.setItem('editorSplitPercent', String(Math.round(editorSplitPercent)));
}

function handleSplitResizeKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') editorSplitPercent = 20;
    else if (event.key === 'End') editorSplitPercent = 80;
    else editorSplitPercent = Math.min(80, Math.max(20, editorSplitPercent + (event.key === 'ArrowRight' ? 5 : -5)));
    updateSplitRatio();
    localStorage.setItem('editorSplitPercent', String(Math.round(editorSplitPercent)));
}

function updateSplitRatio() {
    const splitter = document.querySelector('.editor-splitter');
    if (!splitter) return;
    elements.editorWorkspace.style.setProperty('--editor-left', `${editorSplitPercent}fr`);
    elements.editorWorkspace.style.setProperty('--editor-right', `${100 - editorSplitPercent}fr`);
    splitter.setAttribute('aria-valuenow', String(Math.round(editorSplitPercent)));
}

async function initialize() {
    try {
        const response = await fetch('/api/auth/status');
        if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        const auth = await response.json();
        document.querySelector('#logoutButton').hidden = !auth.enabled;
        if (!auth.authenticated) {
            location.replace('/login.html');
            return;
        }
    } catch (error) {
        showMessage(`Não foi possível verificar o acesso: ${error.message}`, 'error');
        return;
    }
    setupEventListeners();
    setupTheme();
    const savedPanelWidth = Number(localStorage.getItem('workspacePanelWidth'));
    if (Number.isFinite(savedPanelWidth) && savedPanelWidth > 0) workspacePanelWidth = savedPanelWidth;
    setWorkspacePanelWidth(workspacePanelWidth);
    const savedSplit = localStorage.getItem('editorSplitPercent');
    if (savedSplit !== null) {
        const splitPercent = Number(savedSplit);
        if (Number.isFinite(splitPercent)) editorSplitPercent = Math.min(80, Math.max(20, splitPercent));
    }
    updateSplitRatio();
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    syncActiveRailButton();
    const initialListState = captureListState();
    const noteParam = new URLSearchParams(location.search).get('note');
    if (/^\d+$/.test(noteParam || '')) {
        state.directEntry = true;
        state.listState = initialListState;
        history.replaceState({ view: 'editor', noteId: Number(noteParam), list: initialListState, direct: true }, '', location.href);
        void openNote(Number(noteParam), { push: false });
    } else {
        history.replaceState({ view: 'list', list: initialListState }, '', location.href);
        loadNotes();
    }

    loadFolders();
    loadTags();
    void loadFolderNotes('', false);
}

function setupEventListeners() {
    document.querySelectorAll('.rail-button[data-panel]').forEach(button => {
        button.addEventListener('click', () => togglePanel(button.dataset.panel));
    });
    document.querySelectorAll('.rail-button, .brand-mark').forEach(button => {
        button.addEventListener('pointerdown', () => { button.dataset.pointerFocus = ''; });
        button.addEventListener('keydown', () => { delete button.dataset.pointerFocus; });
        button.addEventListener('blur', () => { delete button.dataset.pointerFocus; });
    });
    document.addEventListener('click', event => {
        if (!document.body.classList.contains('panel-open')) return;
        if (elements.panel.contains(event.target) ||
            elements.panelResizer.contains(event.target) ||
            event.target.closest('.rail-button[data-panel]')) return;
        closePanel();
    });
    document.querySelector('#homeButton').addEventListener('click', () => {
        void showAllNotes();
    });
    document.querySelector('#closePanel').addEventListener('click', closePanel);
    elements.panelResizer.addEventListener('pointerdown', startWorkspacePanelResize);
    elements.panelResizer.addEventListener('pointermove', resizeWorkspacePanel);
    elements.panelResizer.addEventListener('pointerup', stopWorkspacePanelResize);
    elements.panelResizer.addEventListener('pointercancel', stopWorkspacePanelResize);
    elements.panelResizer.addEventListener('keydown', handleWorkspacePanelResizeKey);
    window.addEventListener('resize', () => setWorkspacePanelWidth(workspacePanelWidth));
    document.querySelector('#closeGraph').addEventListener('click', closeGraphView);
    document.querySelector('#fitGraph').addEventListener('click', () => graphView.fit());
    document.querySelector('#graphSearch').addEventListener('input', event => graphView.setSearch(event.target.value));
    elements.newNote.addEventListener('click', () => openNewNote());
    document.querySelector('#commandButton').addEventListener('click', () => void commandPalette.open());
    elements.backupInput.addEventListener('change', () => {
        const file = elements.backupInput.files?.[0];
        elements.backupInput.value = '';
        if (file) void importBackup(file);
    });
    elements.deleteCurrentNote.addEventListener('click', deleteCurrentNote);
    document.querySelector('#logoutButton').addEventListener('click', async () => {
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
            location.replace('/login.html');
        } catch (error) {
            showMessage(`Não foi possível encerrar a sessão: ${error.message}`, 'error');
        }
    });
    elements.attachmentsButton.addEventListener('click', event => {
        const dialog = elements.attachmentsDialog;
        if (dialog.open) {
            dialog.close();
            return;
        }
        dialog.style.visibility = 'hidden';
        dialog.show();
        positionAttachmentsDialog();
        dialog.style.visibility = '';
        elements.attachmentsButton.setAttribute('aria-expanded', 'true');
        // Apenas navegação por teclado move o foco para dentro do popover,
        // evitando interromper a seleção de texto ao abrir com o mouse.
        if (event.detail === 0) document.querySelector('#closeAttachments').focus();
        if (state.noteID !== null) void loadAttachments(state.noteID);
    });
    document.querySelector('#closeAttachments').addEventListener('click', () => elements.attachmentsDialog.close());
    elements.attachmentsDialog.addEventListener('close', () => {
        elements.attachmentsButton.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('pointerdown', event => {
        const dialog = elements.attachmentsDialog;
        if (!dialog.open || dialog.contains(event.target) || elements.attachmentsButton.contains(event.target)) return;
        dialog.close();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !elements.attachmentsDialog.open) return;
        elements.attachmentsDialog.close();
        elements.attachmentsButton.focus();
    });
    document.querySelector('#addAttachment').addEventListener('click', () => elements.attachmentInput.click());
    elements.attachmentInput.addEventListener('change', event => {
        const files = [...event.target.files];
        event.target.value = '';
        if (files.length) void uploadAttachments(files);
    });
    elements.attachmentList.addEventListener('click', event => {
        const button = event.target.closest('[data-delete-attachment]');
        if (button) void deleteAttachment(Number(button.dataset.deleteAttachment));
    });
    document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
    document.querySelector('#clearFolder').addEventListener('click', () => selectFolder(''));
    elements.clearTag.addEventListener('click', () => void selectTag(''));
    elements.tagFilterBar.addEventListener('click', event => {
        const button = event.target.closest('[data-tag]');
        if (!button) return;
        const tag = button.dataset.tag || '';
        void selectTag(tag.toLowerCase() === state.tag.toLowerCase() ? '' : tag);
    });
    elements.searchInput.addEventListener('input', () => {
        window.clearTimeout(state.searchTimer);
        state.offset = 0;
        state.searchTimer = window.setTimeout(() => {
            if (state.mode === 'table') applyTableFilter();
            else loadNotes();
            updateListHistory();
        }, 160);
    });
    document.querySelectorAll('[data-mode]').forEach(button => {
        button.addEventListener('click', () => {
            state.mode = button.dataset.mode;
            updateSearchModes();
            state.offset = 0;
            loadNotes();
            updateListHistory();
        });
    });
    elements.previousPage.addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - pageSize);
        loadNotes();
        updateListHistory();
    });
    elements.nextPage.addEventListener('click', () => {
        if (state.offset + pageSize < state.total) {
            state.offset += pageSize;
            loadNotes();
            updateListHistory();
        }
    });
    elements.panelContent.addEventListener('click', handlePanelClick);
    elements.panelContent.addEventListener('dragstart', handleSidebarDragStart);
    elements.panelContent.addEventListener('dragend', clearDropTargets);
    elements.panelContent.addEventListener('dragover', handleSidebarDragOver);
    elements.panelContent.addEventListener('dragleave', handleSidebarDragLeave);
    elements.panelContent.addEventListener('drop', event => void handleSidebarDrop(event));
    elements.notesList.addEventListener('click', handleNoteListClick);
    elements.noteContent.addEventListener('input', () => {
        markdownEditor.handleInput();
        syncPreviewMinimumHeight();
        scheduleWikilinkSuggestions();
    });
    elements.noteContent.addEventListener('keydown', event => {
        if (!handleWikilinkKeydown(event)) markdownEditor.handleKeydown(event);
    });
    elements.noteContent.addEventListener('keyup', event => {
        if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            scheduleWikilinkSuggestions();
        }
    });
    elements.noteContent.addEventListener('click', scheduleWikilinkSuggestions);
    elements.noteContent.addEventListener('blur', () => {
        window.setTimeout(closeWikilinkAutocomplete, 100);
    });
    elements.wikilinkAutocomplete.addEventListener('mousedown', event => event.preventDefault());
    elements.wikilinkAutocomplete.addEventListener('click', event => {
        const option = event.target.closest('[data-wikilink-index]');
        if (!option) return;
        const item = state.wikilinkAutocomplete.items[Number(option.dataset.wikilinkIndex)];
        if (item) acceptWikilinkSuggestion(item);
    });
    elements.wikilinkAutocomplete.addEventListener('mouseover', event => {
        const option = event.target.closest('[data-wikilink-index]');
        if (!option) return;
        state.wikilinkAutocomplete.activeIndex = Number(option.dataset.wikilinkIndex);
        updateWikilinkActiveOption();
    });
    elements.markdownPreview.addEventListener('click', event => {
        const frontmatterToggle = event.target.closest('[data-frontmatter-toggle]');
        if (frontmatterToggle) {
            state.frontmatterExpanded = !state.frontmatterExpanded;
            renderFrontmatterProperties();
            return;
        }
        const link = event.target.closest('a[href]');
        if (!link) return;
        let url;
        try {
            url = new URL(link.getAttribute('href'), window.location.href);
        } catch {
            return;
        }
        if (url.origin !== window.location.origin) return;
        const noteID = url.searchParams.get('note');
        if (!/^\d+$/.test(noteID || '')) return;
        event.preventDefault();
        void openNote(Number(noteID), { heading: url.searchParams.get('heading') || '' });
    });
    elements.noteContent.addEventListener('scroll', () => {
        handleEditorScroll(elements.noteContent);
        elements.noteContentHighlight.scrollTop = elements.noteContent.scrollTop;
        elements.noteContentHighlight.scrollLeft = elements.noteContent.scrollLeft;
        if (state.wikilinkAutocomplete.open) renderWikilinkAutocomplete();
    });
    elements.markdownPreview.addEventListener('scroll', () => handleEditorScroll(elements.markdownPreview));
    // Images load after the first preview render and change its scroll height;
    // recompute the spacer so the panes keep matching scroll ranges.
    elements.markdownPreview.addEventListener('load', () => {
        syncPreviewMinimumHeight();
        syncEditorScrollFromSource();
    }, true);
    window.addEventListener('resize', () => {
        editorLinePositionCache = null;
        positionAttachmentsDialog();
        if (state.table && state.mode === 'table') state.table.setHeight(tableHeight());
        if (state.view === 'editor' && window.matchMedia('(max-width: 700px)').matches &&
            elements.editorWorkspace.dataset.editorMode === 'split') {
            setEditorMode('edit');
        }
        syncPreviewMinimumHeight();
        syncEditorScrollFromSource();
        if (state.wikilinkAutocomplete.open) renderWikilinkAutocomplete();
    });
    elements.noteTitle.addEventListener('input', () => {
        updateEditorBreadcrumb();
        scheduleSave();
    });
    const splitter = document.querySelector('.editor-splitter');
    splitter.addEventListener('pointerdown', startSplitResize);
    splitter.addEventListener('pointermove', resizeSplit);
    splitter.addEventListener('pointerup', stopSplitResize);
    splitter.addEventListener('pointercancel', stopSplitResize);
    splitter.addEventListener('keydown', handleSplitResizeKey);
    document.querySelector('.markdown-tools').addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action?.dataset.action === 'undo') markdownEditor.undo();
        if (action?.dataset.action === 'redo') markdownEditor.redo();
        const button = event.target.closest('[data-format]');
        if (button) markdownEditor.format(button.dataset.format);
    });
    document.querySelectorAll('.editor-mode[data-editor-mode]').forEach(button => {
        button.addEventListener('click', () => setEditorMode(button.dataset.editorMode));
    });
    window.addEventListener('popstate', event => void handlePopState(event));
    window.addEventListener('beforeunload', event => {
        if (state.view === 'editor' && isDraftDirty()) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
            if (event.defaultPrevented) return;
            event.preventDefault();
            if (commandPalette.dialog.open) commandPalette.close();
            else void commandPalette.open();
            return;
        }
        if (commandPalette.dialog.open) return;
        if (event.key === '/' && state.view === 'list' && !isTypingTarget(event.target)) {
            event.preventDefault();
            (state.graphVisible ? document.querySelector('#graphSearch') : elements.searchInput).focus();
        }
        if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && state.view === 'editor') {
            const mobile = window.matchMedia('(max-width: 700px)').matches;
            const modes = mobile ? ['edit', 'preview'] : ['edit', 'split', 'preview'];
            let mode = null;
            if (event.code === 'Digit1') mode = 'edit';
            else if (event.code === 'Digit2') mode = mobile ? 'edit' : 'split';
            else if (event.code === 'Digit3') mode = 'preview';
            else if (event.key.toLowerCase() === 'v') {
                mode = modes[(modes.indexOf(elements.editorWorkspace.dataset.editorMode) + 1) % modes.length];
            }
            if (mode) {
                event.preventDefault();
                setEditorMode(mode);
            }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
            event.preventDefault();
            void openNewNote();
        }
        if (state.view === 'editor' && event.key === 'Escape' && !event.defaultPrevented) {
            if (elements.attachmentsDialog.open) elements.attachmentsDialog.close();
            else navigateBack();
        }
        if (state.view === 'list' && state.graphVisible && event.key === 'Escape' && !event.defaultPrevented) {
            closeGraphView();
        }
    });
}

function isTypingTarget(target) {
    return target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function captureListState() {
    return {
        query: elements.searchInput.value,
        mode: state.mode,
        folder: state.folder,
        tag: state.tag,
        offset: state.offset,
        graphVisible: state.graphVisible
    };
}

function updateListHistory() {
    if (state.view === 'list') {
        history.replaceState({ view: 'list', list: captureListState() }, '', location.href);
    }
}

async function openGraphView() {
    if (state.view === 'editor') {
        if (!(await flushSave())) {
            showMessage('Salve a nota antes de abrir o grafo.', 'error');
            return;
        }
        const listState = state.listState || captureListState();
        history.pushState({ view: 'list', list: { ...listState, graphVisible: true } }, '', location.pathname);
        state.view = 'list';
        state.noteID = null;
        resetBacklinks();
        resetOutline();
        state.directEntry = false;
        document.body.classList.remove('is-editor-view');
        elements.editorView.hidden = true;
        elements.newNote.hidden = false;
        restoreListState({ ...listState, graphVisible: false });
        void loadNotes();
    }
    if (state.view !== 'list') return;
    state.graphVisible = true;
    document.body.classList.add('is-graph-view');
    elements.searchView.hidden = true;
    elements.graphView.hidden = false;
    const graphButton = document.querySelector('#graphButton');
    graphButton.classList.add('is-active');
    graphButton.setAttribute('aria-pressed', 'true');
    updateListHistory();
    requestAnimationFrame(() => graphView.resize());
    if (state.graphData) {
        graphView.setGraph(state.graphData);
        updateGraphSummary(state.graphData);
        return;
    }

    const requestID = ++state.graphRequestID;
    const summary = document.querySelector('#graphSummary');
    summary.innerHTML = '<span class="skeleton skeleton-line" aria-hidden="true"></span>';
    try {
        const graph = await requestJSON('/api/graph');
        if (requestID !== state.graphRequestID || !state.graphVisible) return;
        if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
            throw new Error('Resposta inválida da API do grafo.');
        }
        state.graphData = graph;
        graphView.setGraph(graph);
        updateGraphSummary(graph);
        requestAnimationFrame(() => graphView.fit());
    } catch (error) {
        if (requestID !== state.graphRequestID) return;
        summary.textContent = 'Não foi possível carregar as relações.';
        showMessage(`Não foi possível carregar o grafo: ${error.message}`, 'error');
    }
}

function closeGraphView() {
    if (!state.graphVisible) return;
    state.graphVisible = false;
    state.graphRequestID++;
    document.body.classList.remove('is-graph-view');
    elements.graphView.hidden = true;
    elements.searchView.hidden = false;
    const graphButton = document.querySelector('#graphButton');
    graphButton.classList.remove('is-active');
    graphButton.setAttribute('aria-pressed', 'false');
    updateListHistory();
}

function updateGraphSummary(graph) {
    const nodeCount = graph.nodes.length;
    const edgeCount = graph.edges.length;
    document.querySelector('#graphSummary').textContent =
        `${nodeCount} ${nodeCount === 1 ? 'nota' : 'notas'} · ${edgeCount} ${edgeCount === 1 ? 'relação' : 'relações'}`;
}

function updateSearchModes() {
    document.querySelectorAll('[data-mode]').forEach(button => {
        const active = button.dataset.mode === state.mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const tableMode = state.mode === 'table';
    elements.resultsSection.hidden = tableMode;
    elements.tableView.hidden = !tableMode;
    elements.searchInput.placeholder = tableMode
        ? 'Pesquisar em qualquer coluna...'
        : 'Pesquisar notas...';
    if (tableMode) elements.pagination.hidden = true;
}

async function loadNotes() {
    if (state.mode === 'table') {
        if (state.view === 'editor') return;
        await loadTable();
        return;
    }
    const requestID = ++state.requestID;
    const query = elements.searchInput.value.trim();
    const params = new URLSearchParams({
        folder: state.folder,
        limit: String(pageSize),
        offset: String(state.offset)
    });
    if (state.tag) params.set('tag', state.tag);
    const endpoint = query ? '/api/search' : '/api/notes';
    if (query) {
        params.set('q', query);
        params.set('mode', state.mode);
    }
    if (!state.notesLoaded) renderNoteSkeletons();
    try {
        const page = await requestJSON(`${endpoint}?${params}`);
        if (requestID !== state.requestID) return;
        state.notesLoaded = true;
        if (page.total > 0 && state.offset >= page.total) {
            state.offset = Math.floor((page.total - 1) / pageSize) * pageSize;
            return loadNotes();
        }
        state.notes = page.items;
        state.total = page.total;
        renderNotes(page);
    } catch (error) {
        if (requestID === state.requestID) {
            if (!state.notesLoaded) {
                state.notesLoaded = true;
                elements.notesList.replaceChildren();
            }
            showMessage(`Não foi possível carregar as notas: ${error.message}`, 'error');
        }
    }
}

const tablePropertyPrefix = 'property:';
const tableIcons = {
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16h6"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 5-4 3 2.5 3-3 3 3.5"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 14h6M9 17h4"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
    paperclip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12.5 7.1-7.1a3 3 0 0 1 4.2 4.2l-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2"/></svg>'
};

function tablePropertyField(key) {
    return `${tablePropertyPrefix}${key}`;
}

function invalidateTable() {
    state.tableLoaded = false;
    state.tableKey = '';
}

function normalizeTableSearch(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function flattenTableSearchValues(value, output) {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
        for (const item of value) flattenTableSearchValues(item, output);
        return;
    }
    if (typeof value === 'object') {
        for (const item of Object.values(value)) flattenTableSearchValues(item, output);
        return;
    }
    output.push(String(value));
}

function tableNoteMatches(note, needle) {
    const values = [note.title, note.folder];
    flattenTableSearchValues(note.tags, values);
    for (const value of Object.values(note.properties || {})) flattenTableSearchValues(value, values);
    return values.some(value => normalizeTableSearch(value).includes(needle));
}

function tableAttachmentMatches(attachment, needle) {
    return [attachment.filename, attachment.media_type, formatFileSize(attachment.size)]
        .some(value => normalizeTableSearch(value).includes(needle));
}

function tableFilterRow(data, needle) {
    const values = data.__search || [];
    if (values.some(value => normalizeTableSearch(value).includes(needle))) return true;
    if (data.kind === 'note' && Array.isArray(data.children)) {
        return data.children.some(child => tableFilterRow(child, needle));
    }
    return false;
}

async function loadTable() {
    const key = `${state.folder}\u0000${state.tag}`;
    if (state.tableLoaded && state.tableKey === key) {
        applyTableFilter();
        return;
    }
    const requestID = ++state.tableRequestID;
    const params = new URLSearchParams();
    if (state.folder) params.set('folder', state.folder);
    if (state.tag) params.set('tag', state.tag);
    try {
        const payload = await requestJSON(`/api/table${params.size ? `?${params}` : ''}`);
        if (requestID !== state.tableRequestID) return;
        state.tableData = Array.isArray(payload.items) ? payload.items : [];
        state.tableKey = key;
        state.tableLoaded = true;
        renderTable();
    } catch (error) {
        if (requestID !== state.tableRequestID) return;
        state.tableData = [];
        state.tableLoaded = false;
        renderTable();
        showMessage(`Não foi possível carregar a tabela: ${error.message}`, 'error');
    }
}

function resetTableContainer() {
    const host = document.querySelector('#notesTableHost');
    if (!host) return null;
    const fresh = document.createElement('div');
    fresh.id = 'notesTable';
    fresh.className = 'notes-table';
    host.replaceChildren(fresh);
    elements.notesTable = fresh;
    return fresh;
}

function tableHeight() {
    const host = document.querySelector('#notesTableHost');
    const measured = host?.clientHeight || 0;
    return Math.max(280, Math.floor(measured || window.innerHeight - 360));
}

function tablePropertyKeys(notes) {
    const keys = new Set();
    for (const note of notes) {
        for (const key of Object.keys(note.properties || {})) keys.add(key);
    }
    return [...keys].sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

function tableAttachmentRow(note, attachment) {
    const values = [attachment.filename, attachment.media_type, formatFileSize(attachment.size)];
    return {
        kind: 'attachment',
        noteID: note.id,
        attachmentID: attachment.id,
        filename: attachment.filename,
        media_type: attachment.media_type,
        size: attachment.size,
        url: attachment.url,
        title: attachment.filename,
        folder: '',
        __search: values
    };
}

function renderTable() {
    if (state.table) {
        try {
            state.table.destroy();
        } catch {
            // The table may already be gone after a failed render.
        }
        state.table = null;
    }
    const container = resetTableContainer();
    if (!container) return;
    if (!window.Tabulator) {
        container.textContent = 'Não foi possível carregar o Tabulator.';
        return;
    }

    const propertyKeys = tablePropertyKeys(state.tableData);
    state.tableColumnCount = propertyKeys.length;
    const rows = state.tableData.map(note => {
        const attachments = (note.attachments || []).map(attachment => tableAttachmentRow(note, attachment));
        const row = {
            kind: 'note',
            noteID: note.id,
            title: note.title,
            folder: note.folder || '',
            tags: note.tags || [],
            updated_at: note.updated_at || '',
            created_at: note.created_at || '',
            properties: note.properties || {},
            __search: []
        };
        flattenTableSearchValues(note.title, row.__search);
        flattenTableSearchValues(note.folder, row.__search);
        flattenTableSearchValues(note.tags, row.__search);
        for (const value of Object.values(note.properties || {})) flattenTableSearchValues(value, row.__search);
        for (const attachment of attachments) row.__search.push(...attachment.__search);
        for (const key of propertyKeys) row[tablePropertyField(key)] = row.properties[key] ?? null;
        if (attachments.length) row.children = attachments;
        return row;
    });

    const columns = [
        {
            title: 'Título',
            field: 'title',
            minWidth: 240,
            widthGrow: 3,
            formatter: tableTitleFormatter,
            sorter: tableTextSorter
        },
        {
            title: 'Pasta',
            field: 'folder',
            minWidth: 130,
            widthGrow: 1,
            formatter: tableFolderFormatter,
            sorter: tableTextSorter
        },
        ...propertyKeys.map(key => ({
            title: key,
            field: tablePropertyField(key),
            minWidth: 110,
            widthGrow: 1,
            headerTooltip: `Propriedade do frontmatter: ${key}`,
            formatter: tablePropertyFormatter,
            sorter: tablePropertySorter
        })),
        {
            title: 'Atualizado',
            field: 'updated_at',
            minWidth: 140,
            widthGrow: 1,
            formatter: tableDateFormatter,
            sorter: tableTextSorter
        },
    ];

    state.table = new window.Tabulator(container, {
        data: rows,
        columns,
        height: tableHeight(),
        layout: 'fitDataStretch',
        headerHeight: 36,
        rowHeight: 40,
        placeholder: 'Nenhuma nota encontrada.',
        movableColumns: false,
        resizableColumns: true,
        selectableRows: false,
        dataTree: true,
        dataTreeChildField: 'children',
        dataTreeElementColumn: 'title',
        dataTreeChildIndent: 18,
        dataTreeStartExpanded: false,
        dataTreeFilter: true,
        dataTreeSort: false,
        initialSort: [{ column: 'updated_at', dir: 'desc' }],
        rowFormatter: row => {
            const kind = row.getData().kind;
            row.getElement().classList.add(kind === 'attachment' ? 'is-attachment-row' : 'is-note-row');
        }
    });
    applyTableFilter();
}

function applyTableFilter() {
    if (!state.table) {
        updateTableSummary();
        return;
    }
    const query = elements.searchInput.value.trim();
    if (query) {
        const needle = normalizeTableSearch(query);
        state.table.setFilter(data => tableFilterRow(data, needle));
    } else {
        state.table.clearFilter();
    }
    updateTableSummary();
}

function updateTableSummary() {
    const query = elements.searchInput.value.trim();
    const needle = normalizeTableSearch(query);
    let notes = 0;
    let attachments = 0;
    for (const note of state.tableData) {
        const noteMatches = !needle || tableNoteMatches(note, needle);
        const matchingAttachments = (note.attachments || [])
            .filter(attachment => !needle || tableAttachmentMatches(attachment, needle));
        if (noteMatches || matchingAttachments.length) {
            notes++;
            attachments += matchingAttachments.length;
        }
    }
    const noteLabel = `${notes} ${notes === 1 ? 'nota' : 'notas'}`;
    const attachmentLabel = `${attachments} ${attachments === 1 ? 'anexo' : 'anexos'}`;
    elements.tableSummary.textContent = `${noteLabel} · ${attachmentLabel}`;
    elements.resultCount.textContent = `${noteLabel} · ${attachmentLabel}`;
    elements.tableColumnsInfo.textContent =
        `${state.tableColumnCount} ${state.tableColumnCount === 1 ? 'coluna dinâmica' : 'colunas dinâmicas'}`;
    elements.tableFooterInfo.textContent = query
        ? `${noteLabel} · ${attachmentLabel} para “${query}”`
        : `${noteLabel} · ${attachmentLabel} · colunas geradas do frontmatter`;
}

function tableTextSorter(left, right) {
    return String(left ?? '').localeCompare(String(right ?? ''), 'pt-BR', { sensitivity: 'base' });
}

function tablePropertySorter(left, right) {
    return tableDisplayValue(left).localeCompare(tableDisplayValue(right), 'pt-BR', { sensitivity: 'base' });
}

function tableDisplayValue(value) {
    if (value === null || value === undefined || value === '') return '';
    if (Array.isArray(value)) return value.map(tableDisplayValue).join(', ');
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
    return String(value);
}

function tableNoteIcon() {
    const icon = document.createElement('span');
    icon.className = 'table-cell-icon';
    icon.innerHTML = tableIcons.note;
    return icon;
}

function tableFileIcon(filename) {
    const extension = String(filename || '').split('.').pop()?.toLocaleLowerCase() || '';
    const icon = document.createElement('span');
    icon.className = 'table-cell-icon';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(extension)) {
        icon.classList.add('is-image');
        icon.innerHTML = tableIcons.image;
    } else if (extension === 'pdf') {
        icon.classList.add('is-pdf');
        icon.innerHTML = tableIcons.pdf;
    } else {
        icon.classList.add('is-text');
        icon.innerHTML = tableIcons.file;
    }
    return icon;
}

function tableTitleFormatter(cell) {
    const data = cell.getRow().getData();
    const wrapper = document.createElement('div');
    wrapper.className = 'table-title-cell';

    if (data.kind === 'attachment') {
        wrapper.append(tableFileIcon(data.filename));
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'table-note-link table-file-name';
        link.textContent = data.filename;
        link.title = data.filename;
        link.addEventListener('click', event => {
            event.stopPropagation();
            openTableAttachment(data);
        });
        const type = document.createElement('span');
        type.className = 'table-file-type';
        type.textContent = (data.filename.split('.').pop() || data.media_type.split('/').pop() || 'arquivo').toLocaleUpperCase();
        const size = document.createElement('span');
        size.className = 'table-file-size';
        size.textContent = formatFileSize(data.size);
        wrapper.append(link, type, size);
        return wrapper;
    }

    wrapper.append(tableNoteIcon());
    const copy = document.createElement('div');
    copy.className = 'table-title-copy';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'table-note-link';
    link.textContent = data.title;
    link.title = data.title;
    link.addEventListener('click', event => {
        event.stopPropagation();
        void openNote(data.noteID);
    });
    const count = Array.isArray(data.children) ? data.children.length : 0;
    const subtitle = document.createElement('span');
    subtitle.className = 'table-note-sub';
    subtitle.textContent = count === 0
        ? 'sem anexos'
        : `${count} ${count === 1 ? 'anexo' : 'anexos'}`;
    copy.append(link, subtitle);
    wrapper.append(copy);
    return wrapper;
}

function tableFolderFormatter(cell) {
    const data = cell.getRow().getData();
    const wrapper = document.createElement('div');
    wrapper.className = 'table-folder-cell';
    if (data.kind === 'attachment') {
        const empty = document.createElement('span');
        empty.className = 'table-empty-value';
        empty.textContent = '—';
        wrapper.append(empty);
        return wrapper;
    }
    wrapper.innerHTML = tableIcons.folder;
    const label = document.createElement('span');
    label.textContent = data.folder || 'Raiz';
    label.title = data.folder || 'Raiz';
    if (!data.folder) label.className = 'table-empty-value';
    wrapper.append(label);
    return wrapper;
}

function tablePropertyFormatter(cell) {
    const value = cell.getValue();
    if (Array.isArray(value)) {
        const list = document.createElement('div');
        list.className = 'table-tag-list';
        if (!value.length) {
            list.append(tableMutedValue('—'));
            return list;
        }
        for (const item of value) {
            const tag = document.createElement('span');
            const label = tableDisplayValue(item);
            tag.className = 'table-tag';
            tag.textContent = label;
            tag.title = label;
            list.append(tag);
        }
        return list;
    }
    const text = tableDisplayValue(value);
    if (!text) return tableMutedValue('—');
    const span = document.createElement('span');
    span.className = 'table-property-value';
    span.textContent = text;
    span.title = text;
    return span;
}

function tableDateFormatter(cell) {
    const data = cell.getRow().getData();
    if (data.kind === 'attachment') return tableMutedValue('');
    const value = cell.getValue();
    if (!value) return tableMutedValue('—');
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
    const label = Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleString('pt-BR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    const span = document.createElement('span');
    span.className = 'table-property-value';
    span.textContent = label;
    span.title = value;
    return span;
}

function tableMutedValue(text) {
    const span = document.createElement('span');
    span.className = 'table-empty-value';
    span.textContent = text;
    return span;
}

function tableActionButton(label, icon, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'table-action';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    button.addEventListener('click', onClick);
    return button;
}

function tableActionsFormatter(cell) {
    const data = cell.getRow().getData();
    const wrapper = document.createElement('div');
    wrapper.className = 'table-actions';
    if (data.kind === 'attachment') {
        wrapper.append(
            tableActionButton('Abrir anexo', tableIcons.open, event => {
                event.stopPropagation();
                openTableAttachment(data);
            }),
            tableActionButton('Baixar anexo', tableIcons.download, event => {
                event.stopPropagation();
                downloadTableAttachment(data);
            })
        );
        return wrapper;
    }
    const count = Array.isArray(data.children) ? data.children.length : 0;
    if (count) {
        const badge = document.createElement('span');
        badge.className = 'table-attachment-count';
        badge.title = `${count} ${count === 1 ? 'anexo' : 'anexos'}`;
        badge.innerHTML = tableIcons.paperclip;
        badge.append(document.createTextNode(String(count)));
        wrapper.append(badge);
    }
    return wrapper;
}

function openTableAttachment(data) {
    window.open(`${data.url}?inline=1`, '_blank', 'noopener');
}

function downloadTableAttachment(data) {
    const link = document.createElement('a');
    link.href = data.url;
    link.download = data.filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
}

async function loadFolders() {
    try {
        state.folders = await requestJSON('/api/folders');
        if (!Array.isArray(state.folders)) throw new Error('resposta de pastas inválida');
        if (elements.panel.dataset.panel === 'files') renderFolderPanel();
    } catch (error) {
        showMessage(`Não foi possível carregar as pastas: ${error.message}`, 'error');
    }
}

async function loadFolderNotes(folder, more = false) {
    const previous = state.folderNotes.get(folder);
    if (!more && previous) return;
    if (state.folderNotesLoading.has(folder)) return;
    const generation = state.folderNotesGeneration;
    const offset = more && previous ? previous.items.length : 0;
    const params = new URLSearchParams({ folder, limit: String(treePageSize), offset: String(offset) });
    state.folderNotesLoading.add(folder);
    try {
        const page = await requestJSON(`/api/folder-notes?${params}`);
        if (generation !== state.folderNotesGeneration) return;
        const items = more && previous ? [...previous.items, ...page.items] : page.items;
        state.folderNotes.set(folder, { items, total: page.total });
        if (elements.panel.dataset.panel === 'files') renderFolderPanel();
    } catch (error) {
        showMessage(`Não foi possível carregar as notas da pasta: ${error.message}`, 'error');
    } finally {
        state.folderNotesLoading.delete(folder);
        if (generation !== state.folderNotesGeneration && state.expandedFolders.has(folder)) {
            void loadFolderNotes(folder);
        }
    }
}

function renderNotes(page) {
    elements.notesList.replaceChildren();
    const query = elements.searchInput.value.trim();
    const tagLabel = state.tag ? `#${state.tag}` : '';
    if (query) {
        elements.resultsTitle.textContent = tagLabel
            ? `Resultados para “${query}” em ${tagLabel}`
            : `Resultados para “${query}”`;
    } else if (tagLabel) {
        elements.resultsTitle.textContent = `Notas com ${tagLabel}`;
    } else {
        elements.resultsTitle.textContent = state.folder ? state.folder.split('/').at(-1) : 'Todas as notas';
    }
    elements.resultCount.textContent = `${page.total} ${page.total === 1 ? 'nota' : 'notas'}`;
    if (state.view === 'list') {
        document.querySelector('#currentFolder').textContent = state.folder || 'Todas as notas';
    }
    elements.clearFolder.hidden = !state.folder;
    elements.clearTag.hidden = !state.tag;
    if (page.items.length === 0) {
        elements.notesList.append(createEmptyState({
            query,
            tag: state.tag,
            folder: state.folder
        }));
    } else {
        const contentSearch = Boolean(query && state.mode === 'content');
        for (const note of page.items) elements.notesList.append(createNoteCard(note, contentSearch, query));
    }
    renderTagFilter();
    const first = page.total === 0 ? 0 : page.offset + 1;
    const last = Math.min(page.offset + page.items.length, page.total);
    elements.pagination.hidden = page.total <= page.limit;
    elements.pageStatus.textContent = `${first}–${last} de ${page.total}`;
    elements.previousPage.disabled = page.offset === 0;
    elements.nextPage.disabled = page.offset + page.limit >= page.total;
}

function createEmptyState({ query, tag, folder }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h3');
    const text = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'empty-actions';

    if (query) {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
        title.textContent = 'Nada encontrado';
        text.textContent = `Não encontramos notas para “${query}”. Tente outro termo ou limpe os filtros.`;
        actions.append(
            emptyAction('Limpar filtros', 'muted', 'clear'),
            emptyAction('Nova nota', 'primary', 'new')
        );
    } else if (tag) {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.3"/></svg>';
        title.textContent = `Nenhuma nota com #${tag}`;
        text.textContent = 'Remova o filtro de tag ou crie uma nota com esta tag para começar.';
        actions.append(
            emptyAction('Limpar filtros', 'muted', 'clear'),
            emptyAction('Nova nota', 'primary', 'new')
        );
    } else if (folder) {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2"/></svg>';
        title.textContent = 'Esta pasta está vazia';
        text.textContent = 'Crie uma nota aqui ou mova uma nota existente para esta pasta.';
        actions.append(
            emptyAction('Nova nota', 'primary', 'new'),
            emptyAction('Limpar filtros', 'ghost', 'clear')
        );
    } else {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 2.5h8l4.5 4.5v15H5z"/><path d="M13 2.5V7h4.5M8 11h7m-7 3.5h7"/></svg>';
        title.textContent = 'Seu espaço para pensar';
        text.textContent = 'Crie sua primeira nota ou explore o grafo de relações. Tudo fica salvo localmente.';
        actions.append(
            emptyAction('Nova nota', 'primary', 'new'),
            emptyAction('Explorar grafo', 'ghost', 'graph')
        );
    }

    wrapper.append(icon, title, text, actions);
    return wrapper;
}

function emptyAction(label, variant, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.dataset.variant = variant;
    button.dataset.emptyAction = action;
    button.textContent = label;
    return button;
}

function renderNoteSkeletons() {
    elements.notesList.replaceChildren();
    for (let index = 0; index < 4; index++) {
        const card = document.createElement('div');
        card.className = 'skeleton-card';
        card.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span');
        title.className = 'skeleton skeleton-line is-title';
        const preview = document.createElement('span');
        preview.className = 'skeleton skeleton-line';
        preview.style.width = `${68 + index * 5}%`;
        const meta = document.createElement('span');
        meta.className = 'skeleton skeleton-line is-short';
        card.append(title, preview, meta);
        elements.notesList.append(card);
    }
}

function skeletonLines(count) {
    return Array.from({ length: count }, () => {
        const line = document.createElement('span');
        line.className = 'skeleton skeleton-line';
        line.setAttribute('aria-hidden', 'true');
        return line;
    });
}


function createNoteCard(note, contentSearch, query = '') {
    const card = document.createElement('article');
    card.className = `note-card card${contentSearch ? ' is-content-result' : ''}`;
    card.dataset.noteId = String(note.id);
    if (contentSearch) card.dataset.searchQuery = query;
    const main = document.createElement('button');
    main.className = 'note-card-main';
    main.type = 'button';
    main.dataset.action = 'open';
    const title = document.createElement('span');
    title.className = 'note-title';
    title.textContent = note.title;
    main.append(title);
    if (contentSearch) {
        const preview = document.createElement('span');
        preview.className = 'note-preview';
        const snippets = Array.isArray(note.snippets) && note.snippets.length
            ? note.snippets
            : [note.preview || 'Nenhum trecho disponível.'];
        for (const value of snippets) {
            const snippet = document.createElement('span');
            snippet.className = 'note-preview-snippet';
            appendHighlightedPreview(snippet, value);
            preview.append(snippet);
        }
        main.append(preview);
    }
    const info = document.createElement('div');
    info.className = 'note-meta';
    const tags = document.createElement('div');
    tags.className = 'note-tags';
    for (const value of note.tags || []) {
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.className = `note-tag${value.toLowerCase() === state.tag.toLowerCase() ? ' is-active' : ''}`;
        tag.dataset.action = 'tag';
        tag.dataset.tag = value;
        tag.title = `Filtrar por #${value}`;
        tag.textContent = `#${value}`;
        tags.append(tag);
    }
    if (tags.childElementCount) info.append(tags);
    if (note.folder) {
        const folder = document.createElement('span');
        folder.className = 'note-folder';
        folder.title = note.folder;
        folder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
        const label = document.createElement('span');
        label.textContent = note.folder;
        folder.append(label);
        info.append(folder);
    }
    if (contentSearch && note.occurrences > 1) {
        const occurrences = document.createElement('button');
        occurrences.type = 'button';
        occurrences.className = 'note-hit-count note-occurrences-toggle';
        occurrences.dataset.action = 'occurrences';
        occurrences.dataset.count = String(note.occurrences);
        occurrences.setAttribute('aria-expanded', 'false');
        occurrences.title = `Ver todas as ${note.occurrences} ocorrências nesta nota`;
        occurrences.innerHTML = `<span>${note.occurrences} ocorrências</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
        info.append(occurrences);
    }
    const actions = document.createElement('div');
    actions.className = 'note-actions';
    const remove = document.createElement('button');
    remove.className = 'icon-button danger-hover';
    remove.type = 'button';
    remove.dataset.action = 'delete';
    remove.setAttribute('aria-label', `Excluir ${note.title}`);
    remove.title = 'Excluir';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>';
    actions.append(remove);
    card.append(main);
    if (info.childElementCount) card.append(info);
    card.append(actions);
    return card;
}

function appendHighlightedPreview(container, text) {
    const startMarker = '<mark>';
    const endMarker = '</mark>';
    let remaining = text;
    while (remaining) {
        const start = remaining.indexOf(startMarker);
        if (start < 0) {
            container.append(document.createTextNode(remaining));
            break;
        }
        if (start > 0) container.append(document.createTextNode(remaining.slice(0, start)));
        const contentStart = start + startMarker.length;
        const end = remaining.indexOf(endMarker, contentStart);
        if (end < 0) {
            container.append(document.createTextNode(remaining.slice(start)));
            break;
        }
        const highlight = document.createElement('mark');
        highlight.textContent = remaining.slice(contentStart, end);
        container.append(highlight);
        remaining = remaining.slice(end + endMarker.length);
    }
}

function handleNoteListClick(event) {
    const empty = event.target.closest('[data-empty-action]');
    if (empty) {
        void handleEmptyAction(empty.dataset.emptyAction);
        return;
    }
    const action = event.target.closest('[data-action]');
    const card = event.target.closest('[data-note-id]');
    if (!card || !action) return;
    const id = Number(card.dataset.noteId);
    if (action.dataset.action === 'open') void openNote(id);
    else if (action.dataset.action === 'occurrences') void toggleNoteOccurrences(card, action);
    else if (action.dataset.action === 'tag') void selectTag(action.dataset.tag || '');
    else if (action.dataset.action === 'delete') void deleteNote(id);
}

async function toggleNoteOccurrences(card, toggle) {
    const expanded = card.classList.toggle('is-expanded');
    toggle.setAttribute('aria-expanded', String(expanded));
    const count = toggle.dataset.count || '';
    toggle.title = expanded ? 'Recolher ocorrências' : `Ver todas as ${count} ocorrências nesta nota`;
    if (!expanded || card.dataset.occurrencesLoaded === 'true') return;
    const query = card.dataset.searchQuery || elements.searchInput.value.trim();
    if (!query) return;
    card.dataset.occurrencesLoading = 'true';
    toggle.setAttribute('aria-busy', 'true');
    try {
        const id = Number(card.dataset.noteId);
        const params = new URLSearchParams({ q: query });
        const payload = await requestJSON(`/api/notes/${id}/occurrences?${params}`);
        const snippets = Array.isArray(payload.snippets) ? payload.snippets : [];
        const preview = card.querySelector('.note-preview');
        if (preview && snippets.length) {
            preview.replaceChildren();
            for (const value of snippets) {
                const snippet = document.createElement('span');
                snippet.className = 'note-preview-snippet';
                appendHighlightedPreview(snippet, value);
                preview.append(snippet);
            }
        }
        card.dataset.occurrencesLoaded = 'true';
    } catch (error) {
        card.classList.remove('is-expanded');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.title = `Ver todas as ${count} ocorrências nesta nota`;
        showMessage(`Não foi possível carregar as ocorrências: ${error.message}`, 'error');
    } finally {
        delete card.dataset.occurrencesLoading;
        toggle.removeAttribute('aria-busy');
    }
}

async function handleEmptyAction(action) {
    if (action === 'new') {
        await openNewNote();
        return;
    }
    if (action === 'graph') {
        await openGraphView();
        return;
    }
    if (action === 'clear') {
        elements.searchInput.value = '';
        state.tag = '';
        state.folder = '';
        state.offset = 0;
        if (state.graphVisible) closeGraphView();
        await loadNotes();
        updateListHistory();
    }
}

async function loadTags() {
    try {
        const tags = await requestJSON('/api/tags');
        if (!Array.isArray(tags)) throw new Error('resposta de tags inválida');
        state.tags = tags;
        renderTagFilter();
    } catch (error) {
        state.tags = [];
        renderTagFilter();
    }
}

function renderTagFilter() {
    elements.tagFilterBar.replaceChildren();
    const tags = state.tags.filter(tag => tag && tag.name);
    elements.tagFilterBar.hidden = tags.length === 0;
    for (const tag of tags) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `chip tag-filter${tag.name.toLowerCase() === state.tag.toLowerCase() ? ' is-active' : ''}`;
        button.dataset.tag = tag.name;
        button.setAttribute('aria-pressed', String(tag.name.toLowerCase() === state.tag.toLowerCase()));
        button.title = `Filtrar por #${tag.name}`;
        const name = document.createElement('span');
        name.textContent = `#${tag.name}`;
        const count = document.createElement('span');
        count.className = 'chip-count tag-filter-count';
        count.textContent = String(tag.count);
        button.append(name, count);
        elements.tagFilterBar.append(button);
    }
}

async function exportBackup(button = document.querySelector('#exportBackup')) {
    if (button) button.disabled = true;
    try {
        const response = await fetch('/api/backup');
        if (response.status === 401) {
            location.replace('/login.html');
            return;
        }
        if (!response.ok) {
            throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = /filename="?([^";]+)"?/i.exec(disposition);
        const filename = match ? match[1] : `pkm-notes-${new Date().toISOString().slice(0, 10)}.zip`;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showMessage('Backup exportado.', 'success');
    } catch (error) {
        showMessage(`Não foi possível exportar o backup: ${error.message}`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function importBackup(file, button = document.querySelector('#importBackup')) {
    if (!window.confirm(
        'Restaurar este backup substitui TODAS as notas, pastas, tags e anexos atuais.\n\n' +
        'Essa ação não pode ser desfeita. Deseja continuar?'
    )) return;
    if (button) button.disabled = true;
    try {
        window.clearTimeout(state.saveTimer);
        if (state.savePromise) await state.savePromise;
        const response = await fetch('/api/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: file
        });
        if (response.status === 401) {
            location.replace('/login.html');
            return;
        }
        if (!response.ok) {
            throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        }
        const result = await response.json();
        window.alert(
            `Backup restaurado: ${result.notes} ${result.notes === 1 ? 'nota' : 'notas'} e ` +
            `${result.attachments} ${result.attachments === 1 ? 'anexo' : 'anexos'}.\n\n` +
            'A página será recarregada.'
        );
        location.replace('/');
    } catch (error) {
        showMessage(`Não foi possível restaurar o backup: ${error.message}`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function selectTag(tag) {
    if (state.view === 'editor' && !(await flushSave())) return;
    if (state.graphVisible) closeGraphView();
    if (state.view === 'editor') {
        history.pushState({ view: 'list', list: { ...captureListState(), tag, offset: 0 } }, '', location.pathname);
        state.view = 'list';
        state.noteID = null;
        resetBacklinks();
        resetOutline();
        document.body.classList.remove('is-editor-view');
        elements.editorView.hidden = true;
        elements.searchView.hidden = false;
        elements.newNote.hidden = false;
    }
    state.tag = tag;
    state.offset = 0;
    updateListHistory();
    await loadNotes();
    if (elements.panel.dataset.panel === 'search') elements.searchInput.focus();
}

function isSameWikilinkToken(current, token) {
    return Boolean(current) && current.query === token.query &&
        current.tokenStart === token.tokenStart && current.hasHeading === token.hasHeading;
}

function normalizeAutocompleteText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function pickWikilinkNote(items, noteQuery) {
    const normalized = normalizeLinkPath(noteQuery);
    if (!normalized) return items[0] || null;
    return items.find(note => normalizeLinkPath(note.title) === normalized ||
        normalizeLinkPath(`${note.folder}/${note.title}`) === normalized) ||
        items.find(note => normalizeLinkPath(note.title).endsWith(`/${normalized}`)) ||
        items[0] || null;
}

function buildHeadingOptions(headings, headingQuery, reference) {
    const needle = normalizeAutocompleteText(headingQuery).trim();
    return headings
        .filter(heading => !needle || normalizeAutocompleteText(heading.text).includes(needle))
        .map(heading => ({
            label: heading.text,
            secondary: `H${heading.level}`,
            insert: `${reference}#${heading.text}`,
            kind: 'heading',
            prefix: Boolean(needle) && normalizeAutocompleteText(heading.text).trim().startsWith(needle)
        }))
        .sort((a, b) => Number(b.prefix) - Number(a.prefix))
        .slice(0, 8);
}

async function showWikilinkNoteSuggestions(token, requestID) {
    const query = token.query.trim();
    const params = new URLSearchParams({ limit: '100', offset: '0' });
    let url = `/api/notes?${params}`;
    if (query) {
        params.set('q', query);
        params.set('mode', 'title');
        url = `/api/search?${params}`;
    }
    const page = await requestJSON(url);
    const currentToken = markdownEditor.getWikilinkToken();
    if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;

    const counts = new Map();
    for (const note of page.items) {
        const key = note.title.trim().toLocaleLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const normalizedQuery = normalizeAutocompleteText(query);
    state.wikilinkAutocomplete.mode = 'note';
    state.wikilinkAutocomplete.items = page.items
        .map(note => ({
            label: note.title,
            secondary: note.folder,
            insert: counts.get(note.title.trim().toLocaleLowerCase()) > 1 && note.folder
                ? `${note.folder}/${note.title}`
                : note.title,
            kind: 'note',
            prefix: normalizeAutocompleteText(note.title).startsWith(normalizedQuery),
            updated: note.updated_at || ''
        }))
        .sort((a, b) => Number(b.prefix) - Number(a.prefix) ||
            b.updated.localeCompare(a.updated) || a.label.localeCompare(b.label))
        .slice(0, 8);
    state.wikilinkAutocomplete.activeIndex = 0;
    state.wikilinkAutocomplete.open = state.wikilinkAutocomplete.items.length > 0;
    renderWikilinkAutocomplete();
}

async function showWikilinkHeadingSuggestions(token, requestID) {
    const noteQuery = token.noteQuery.trim();
    let reference = '';
    let headings = [];
    if (!noteQuery) {
        headings = extractMarkdownOutline(elements.noteContent.value);
    } else {
        const cacheKey = normalizeAutocompleteText(noteQuery);
        const cached = state.wikilinkHeadingCache.get(cacheKey);
        if (cached) {
            reference = cached.reference;
            headings = cached.headings;
        } else {
            const searchQuery = noteQuery.replace(/\.md$/i, '').split('/').filter(Boolean).pop() || noteQuery;
            const params = new URLSearchParams({ limit: '100', offset: '0', q: searchQuery, mode: 'title' });
            const page = await requestJSON(`/api/search?${params}`);
            let currentToken = markdownEditor.getWikilinkToken();
            if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;

            const note = pickWikilinkNote(page.items, noteQuery);
            if (note) {
                const noteData = await requestJSON(`/api/notes/${note.id}`);
                currentToken = markdownEditor.getWikilinkToken();
                if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;
                headings = extractMarkdownOutline(noteData.content);
                reference = noteQuery.includes('/') && note.folder
                    ? `${note.folder}/${note.title}`
                    : note.title;
                state.wikilinkHeadingCache.set(cacheKey, { reference, headings });
            }
        }
    }

    const currentToken = markdownEditor.getWikilinkToken();
    if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;

    state.wikilinkAutocomplete.mode = 'heading';
    state.wikilinkAutocomplete.items = buildHeadingOptions(headings, token.headingQuery, reference);
    state.wikilinkAutocomplete.activeIndex = 0;
    state.wikilinkAutocomplete.open = state.wikilinkAutocomplete.items.length > 0;
    renderWikilinkAutocomplete();
}

function scheduleWikilinkSuggestions() {
    const token = markdownEditor.getWikilinkToken();
    if (state.view !== 'editor' || !token) {
        closeWikilinkAutocomplete();
        return;
    }
    window.clearTimeout(state.wikilinkTimer);
    state.wikilinkAutocomplete.open = false;
    elements.wikilinkAutocomplete.hidden = true;
    elements.noteContent.setAttribute('aria-expanded', 'false');
    elements.noteContent.removeAttribute('aria-activedescendant');
    const requestID = ++state.wikilinkRequestID;
    state.wikilinkTimer = window.setTimeout(async () => {
        try {
            if (token.hasHeading) await showWikilinkHeadingSuggestions(token, requestID);
            else await showWikilinkNoteSuggestions(token, requestID);
        } catch (error) {
            if (requestID === state.wikilinkRequestID) {
                closeWikilinkAutocomplete();
                showMessage(`Não foi possível buscar sugestões para o link: ${error.message}`, 'error');
            }
        }
    }, 100);
}

function renderWikilinkAutocomplete() {
    const popup = elements.wikilinkAutocomplete;
    const headingMode = state.wikilinkAutocomplete.mode === 'heading';
    popup.setAttribute('aria-label', headingMode ? 'Cabeçalhos para link' : 'Notas para link');
    popup.replaceChildren();
    state.wikilinkAutocomplete.items.forEach((item, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'wikilink-option';
        option.dataset.wikilinkIndex = String(index);
        option.id = `wikilink-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === state.wikilinkAutocomplete.activeIndex));
        if (index === state.wikilinkAutocomplete.activeIndex) option.classList.add('is-active');
        if (headingMode) {
            const marker = document.createElement('span');
            marker.className = 'wikilink-option-marker';
            marker.textContent = '#';
            option.append(marker);
        }
        const label = document.createElement('span');
        label.className = 'wikilink-option-label';
        label.textContent = item.label;
        option.append(label);
        if (item.secondary) {
            const folder = document.createElement('span');
            folder.className = headingMode ? 'wikilink-option-level' : 'wikilink-option-folder';
            folder.textContent = item.secondary;
            option.append(folder);
        }
        popup.append(option);
    });
    popup.hidden = !state.wikilinkAutocomplete.open;
    elements.noteContent.setAttribute('aria-expanded', String(state.wikilinkAutocomplete.open));
    if (state.wikilinkAutocomplete.open) {
        elements.noteContent.setAttribute(
            'aria-activedescendant',
            `wikilink-option-${state.wikilinkAutocomplete.activeIndex}`
        );
        const position = getTextareaCaretPosition(elements.noteContent, elements.noteContent.selectionStart);
        const bounds = popup.getBoundingClientRect();
        const left = Math.min(position.left, window.innerWidth - bounds.width - 8);
        const top = position.top + bounds.height > window.innerHeight
            ? Math.max(8, position.top - position.height - bounds.height)
            : position.top;
        popup.style.left = `${Math.max(8, left)}px`;
        popup.style.top = `${Math.max(8, top)}px`;
    } else {
        elements.noteContent.removeAttribute('aria-activedescendant');
    }
}

function getTextareaCaretPosition(textarea, caret) {
    const computed = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const style = mirror.style;
    for (const property of [
        'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
        'borderLeftWidth', 'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom',
        'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
        'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
        'wordSpacing', 'lineHeight', 'tabSize'
    ]) style[property] = computed[property];
    style.position = 'absolute';
    style.visibility = 'hidden';
    style.whiteSpace = 'pre-wrap';
    style.wordWrap = 'break-word';
    style.overflowWrap = 'break-word';
    style.height = 'auto';
    style.left = '-100000px';
    style.top = '0';
    mirror.textContent = textarea.value.slice(0, caret);
    const marker = document.createElement('span');
    marker.textContent = textarea.value.slice(caret) || '.';
    mirror.append(marker);
    document.body.append(mirror);
    const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
    const top = marker.offsetTop + (parseFloat(computed.borderTopWidth) || 0);
    const left = marker.offsetLeft + (parseFloat(computed.borderLeftWidth) || 0);
    mirror.remove();
    const bounds = textarea.getBoundingClientRect();
    return {
        top: bounds.top + top - textarea.scrollTop + lineHeight,
        left: bounds.left + left - textarea.scrollLeft,
        height: lineHeight
    };
}

function handleWikilinkKeydown(event) {
    if (!state.wikilinkAutocomplete.open) return false;
    const { items, activeIndex } = state.wikilinkAutocomplete;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.wikilinkAutocomplete.activeIndex =
            (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        renderWikilinkAutocomplete();
        return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (items[activeIndex]) acceptWikilinkSuggestion(items[activeIndex]);
        return true;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeWikilinkAutocomplete();
        return true;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) closeWikilinkAutocomplete();
    return false;
}

function acceptWikilinkSuggestion(item) {
    closeWikilinkAutocomplete();
    markdownEditor.acceptWikilink(item.insert);
}

function updateWikilinkActiveOption() {
    for (const [index, option] of [...elements.wikilinkAutocomplete.children].entries()) {
        const active = index === state.wikilinkAutocomplete.activeIndex;
        option.classList.toggle('is-active', active);
        option.setAttribute('aria-selected', String(active));
    }
}

function closeWikilinkAutocomplete() {
    window.clearTimeout(state.wikilinkTimer);
    state.wikilinkRequestID++;
    state.wikilinkAutocomplete.open = false;
    state.wikilinkAutocomplete.items = [];
    elements.wikilinkAutocomplete.hidden = true;
    elements.noteContent.setAttribute('aria-expanded', 'false');
    elements.noteContent.removeAttribute('aria-activedescendant');
}

async function openNewNote(folder = state.folder) {
    if (state.view === 'editor' && !(await flushSave())) return;
    if (state.view === 'list') state.listState = captureListState();
    history.pushState({ view: 'editor', noteId: null, list: state.listState, direct: false }, '', location.pathname);
    state.directEntry = false;
    showEditor(null);
    state.noteFolder = folder;
}

function createAutomaticNoteTitle(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    const day = `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function openNote(id, { push = true, backlinkTarget = null, heading = '' } = {}) {
    if (state.view === 'editor' && !(await flushSave())) return;
    const navigationID = ++state.navigationID;
    let listState = state.view === 'editor' ? state.listState : captureListState();
    try {
        const note = await requestJSON(`/api/notes/${id}`);
        if (navigationID !== state.navigationID) return;
        state.listState = listState;
        if (push) {
            history.pushState({ view: 'editor', noteId: id, list: listState, direct: false }, '', `?note=${id}`);
            state.directEntry = false;
        }
        showEditor(note);
        state.pendingBacklink = backlinkTarget;
        if (backlinkTarget) updatePreview();
        if (heading) scrollToLinkedHeading(heading);
    } catch (error) {
        showMessage(`Não foi possível abrir a nota: ${error.message}`, 'error');
    }
}

function showEditor(note) {
    window.clearTimeout(state.saveTimer);
    closeWikilinkAutocomplete();
    state.wikilinkHeadingCache.clear();
    elements.attachmentsDialog.close();
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    document.body.classList.remove('is-graph-view');
    document.body.classList.add('is-editor-view');
    state.view = 'editor';
    state.noteID = note?.id ?? null;
    state.noteVersion = note?.version ?? null;
    elements.searchView.hidden = true;
    elements.graphView.hidden = true;
    elements.editorView.hidden = false;
    elements.newNote.hidden = true;
    elements.noteTitle.value = note ? note.title : createAutomaticNoteTitle();
    state.frontmatterExpanded = false;
    state.noteFolder = note ? note.folder : state.folder;
    elements.deleteCurrentNote.hidden = !note;
    elements.attachmentList.replaceChildren();
    elements.attachmentList.hidden = true;
    elements.attachmentsEmpty.hidden = false;
    elements.attachmentsButton.title = 'Abrir anexos';
    elements.attachmentsButton.setAttribute('aria-label', 'Abrir anexos');
    resetBacklinks();
    state.pendingBacklink = null;
    state.pendingOutlineLine = null;
    elements.saveStatus.className = 'save-status';
    elements.saveStatus.textContent = note ? 'Salvo' : 'Rascunho';
    const content = note ? ensureFrontmatterTags(note.content, note.tags || []) : '';
    state.outline = extractMarkdownOutline(content);
    updateOutlineCount();
    renderedPreviewMarkdown = '';
    editorLinePositionCache = null;
    scrollSyncSuspendedUntil = 0;
    programmaticScroll = null;
    elements.noteContent.value = content;
    state.savedDraft = getDraft();
    markdownEditor.setValue(content);
    const savedMode = localStorage.getItem('editorMode');
    const preferredMode = ['edit', 'split', 'preview'].includes(savedMode) ? savedMode : 'split';
    setEditorMode(window.matchMedia('(max-width: 700px)').matches && preferredMode === 'split'
        ? 'edit'
        : preferredMode);
    updatePreview();
    elements.noteContent.focus();
    updateEditorBreadcrumb();
    if (note) {
        void loadAttachments(note.id);
        void loadBacklinks(note.id);
    } else if (elements.panel.dataset.panel === 'backlinks') {
        renderBacklinksPanel();
    } else if (elements.panel.dataset.panel === 'outline') {
        renderOutlinePanel();
    }
}

function updateEditorBreadcrumb() {
    elements.currentFolder.textContent = state.noteFolder || 'Sem pasta';
    elements.noteTitle.title = elements.noteTitle.value || 'Título da nota';
}

// Moving a note or folder can rewrite links in the note that is currently
// open. Reload it when the local draft is clean so the editor does not save
// the stale content over the server-side fix.
async function refreshOpenNoteAfterMove() {
    if (state.view !== 'editor' || state.noteID === null || isDraftDirty()) return;
    const id = state.noteID;
    try {
        const note = await requestJSON(`/api/notes/${id}`);
        if (state.view !== 'editor' || state.noteID !== id || isDraftDirty()) return;
        state.noteFolder = note.folder;
        state.noteVersion = note.version ?? state.noteVersion;
        const content = ensureFrontmatterTags(note.content, note.tags || []);
        if (content !== elements.noteContent.value) {
            elements.noteContent.value = content;
            state.savedDraft = getDraft();
            markdownEditor.setValue(content);
            renderedPreviewMarkdown = '';
            editorLinePositionCache = null;
            state.outline = extractMarkdownOutline(content);
            updateOutlineCount();
            updatePreview();
        }
        state.savedDraft = getDraft();
        updateEditorBreadcrumb();
        void loadBacklinks(id);
    } catch (error) {
        // The move itself succeeded; keep the local editor state on failure.
    }
}

function getDraft() {
    return {
        title: elements.noteTitle.value,
        folder: state.noteFolder,
        content: elements.noteContent.value
    };
}

function isDraftDirty(draft = getDraft()) {
    return JSON.stringify(draft) !== JSON.stringify(state.savedDraft);
}

function scheduleSave() {
    if (state.view !== 'editor') return;
    if (!isDraftDirty()) {
        setSaveStatus(state.noteID ? 'Salvo' : 'Rascunho', '');
        return;
    }
    setSaveStatus(state.savePromise ? 'Salvando…' : 'Alterações pendentes', 'pending');
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => void persistDraft(), 650);
}

async function persistDraft() {
    if (state.savePromise) {
        await state.savePromise;
        return isDraftDirty() ? persistDraft() : true;
    }
    const draft = getDraft();
    if (!isDraftDirty(draft)) return true;
    const note = {
        title: draft.title.trim(),
        folder: draft.folder,
        content: draft.content
    };
    if (!note.title) {
        setSaveStatus('Informe um título para salvar', 'error');
        return false;
    }
    const id = state.noteID;
    if (id !== null) note.version = state.noteVersion;
    const endpoint = id === null ? '/api/notes' : `/api/notes/${id}`;
    const method = id === null ? 'POST' : 'PUT';
    setSaveStatus('Salvando…', 'pending');
    const job = (async () => {
        try {
            let saved;
            try {
                saved = await requestJSON(endpoint, { method, body: JSON.stringify(note) });
            } catch (error) {
                if (error.status !== 409 || !error.body?.note || id === null) throw error;
                const reload = window.confirm(
                    'Esta nota foi alterada em outra aba.\n\n' +
                    'OK: recarregar a versão mais recente e descartar suas mudanças.\n' +
                    'Cancelar: manter suas mudanças e sobrescrever a versão mais recente.'
                );
                if (reload) {
                    showEditor(error.body.note);
                    setSaveStatus('Versão mais recente carregada', 'saved');
                    return false;
                }
                state.noteVersion = error.body.note.version;
                note.version = state.noteVersion;
                saved = await requestJSON(endpoint, { method, body: JSON.stringify(note) });
            }
            state.noteVersion = saved.version ?? state.noteVersion;
            state.graphData = null;
            invalidateTable();
            if (id === null) {
                state.noteID = saved.id;
                updatePreview();
                elements.deleteCurrentNote.hidden = false;
                void loadAttachments(saved.id);
                const current = history.state || {};
                history.replaceState({ ...current, view: 'editor', noteId: saved.id, list: state.listState }, '', `?note=${saved.id}`);
            }
            void loadBacklinks(state.noteID);
            if (JSON.stringify(getDraft()) === JSON.stringify(draft)) {
                elements.noteTitle.value = saved.title;
                state.noteFolder = saved.folder;
                state.savedDraft = getDraft();
                updateEditorBreadcrumb();
            } else {
                state.savedDraft = draft;
            }
            updateEditorBreadcrumb();
            setSaveStatus('Salvo automaticamente', 'saved');
            state.folderNotesGeneration++;
            state.folderNotes.clear();
            void Promise.all([loadFolders(), loadNotes(), loadTags()]);
            void loadFolderNotes('', false);
            return true;
        } catch (error) {
            setSaveStatus(`Falha ao salvar: ${error.message}`, 'error');
            return false;
        }
    })();
    state.savePromise = job;
    const result = await job;
    state.savePromise = null;
    if (result && isDraftDirty()) {
        window.clearTimeout(state.saveTimer);
        state.saveTimer = window.setTimeout(() => void persistDraft(), 0);
    }
    return result;
}

async function flushSave() {
    window.clearTimeout(state.saveTimer);
    while (state.savePromise) {
        await state.savePromise;
        if (state.savePromise) continue;
    }
    if (!isDraftDirty()) return true;
    if (!elements.noteTitle.value.trim()) {
        setSaveStatus('Informe um título antes de sair', 'error');
        elements.noteTitle.focus();
        return false;
    }
    const success = await persistDraft();
    if (!success) return false;
    if (isDraftDirty()) return flushSave();
    return true;
}

function setSaveStatus(message, stateName) {
    elements.saveStatus.textContent = message;
    elements.saveStatus.dataset.state = stateName;
    elements.saveStatus.className = `save-status${stateName ? ` is-${stateName}` : ''}`;
}

function positionAttachmentsDialog() {
    const dialog = elements.attachmentsDialog;
    if (!dialog.open) return;
    const button = elements.attachmentsButton.getBoundingClientRect();
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const margin = 12;
    const gap = 8;
    const left = Math.max(margin, Math.min(
        button.right - width,
        window.innerWidth - width - margin
    ));
    let top = button.bottom + gap;
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, button.top - height - gap);
    }
    dialog.style.left = `${Math.round(left)}px`;
    dialog.style.top = `${Math.round(top)}px`;
}

async function loadAttachments(noteID) {
    try {
        const attachments = await requestJSON(`/api/notes/${noteID}/attachments`);
        if (state.noteID === noteID) renderAttachments(attachments, noteID);
    } catch (error) {
        if (state.noteID === noteID) showMessage(`Não foi possível carregar os anexos: ${error.message}`, 'error');
    }
}

function renderAttachments(attachments, noteID) {
    const list = elements.attachmentList;
    list.replaceChildren();
    for (const attachment of attachments) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = attachment.url;
        link.textContent = `${attachment.filename} (${formatFileSize(attachment.size)})`;
        link.title = attachment.filename;
        const remove = document.createElement('button');
        remove.className = 'attachment-remove';
        remove.type = 'button';
        remove.dataset.deleteAttachment = String(attachment.id);
        remove.dataset.noteId = String(noteID);
        remove.setAttribute('aria-label', `Excluir anexo ${attachment.filename}`);
        remove.textContent = '×';
        item.append(link, remove);
        list.append(item);
    }
    list.hidden = attachments.length === 0;
    elements.attachmentsEmpty.hidden = attachments.length !== 0;
    const label = attachments.length ? `Anexos (${attachments.length})` : 'Abrir anexos';
    elements.attachmentsButton.title = label;
    elements.attachmentsButton.setAttribute('aria-label', label);
    positionAttachmentsDialog();
}

function formatFileSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function uploadAttachments(files) {
    if (!(await flushSave()) || state.noteID === null) return;
    const noteID = state.noteID;
    for (const file of files) {
        const form = new FormData();
        form.append('file', file, file.name);
        try {
            const response = await fetch(`/api/notes/${noteID}/attachments`, { method: 'POST', body: form });
            if (response.status === 401) {
                location.replace('/login.html');
                return;
            }
            if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
            const attachment = await response.json();
            if (state.noteID === noteID) {
                insertAttachmentMarkdown(attachment);
                await loadAttachments(noteID);
            }
        } catch (error) {
            showMessage(`Não foi possível enviar ${file.name}: ${error.message}`, 'error');
            return;
        }
    }
    if (state.noteID === noteID) await flushSave();
}

function insertAttachmentMarkdown(attachment) {
    const textarea = elements.noteContent;
    const label = attachment.filename.replace(/[\r\n]/g, ' ').replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
    const inlineImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(attachment.media_type);
    const destination = `${attachment.url}${inlineImage ? '?inline=1' : ''}`;
    const markdown = inlineImage ? `![${label}](${destination})` : `[${label}](${destination})`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? '\n' : '';
    const suffix = after && !/^\s/.test(after) ? '\n' : '';
    const next = `${before}${prefix}${markdown}${suffix}${after}`;
    const cursor = before.length + prefix.length + markdown.length + suffix.length;
    textarea.value = next;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
    markdownEditor.handleInput();
}

async function deleteAttachment(attachmentID) {
    const noteID = state.noteID;
    if (noteID === null) return;
    const button = document.querySelector(`[data-delete-attachment="${attachmentID}"]`);
    const filename = button?.previousElementSibling?.textContent || 'este anexo';
    if (!window.confirm(`Excluir ${filename}? Essa ação não pode ser desfeita.`)) return;
    try {
        await requestJSON(`/api/notes/${noteID}/attachments/${attachmentID}`, { method: 'DELETE' });
        await loadAttachments(noteID);
        showMessage('Anexo excluído.', 'success');
    } catch (error) {
        showMessage(`Não foi possível excluir o anexo: ${error.message}`, 'error');
    }
}

function navigateBack() {
    if (state.view !== 'editor') return;
    if (state.directEntry) {
        void returnToList(state.listState || captureListState(), true);
    } else {
        history.back();
    }
}

async function showAllNotes() {
    const allNotes = { query: '', mode: 'title', folder: '', tag: '', offset: 0, graphVisible: false };
    if (state.view === 'editor') {
        await returnToList(allNotes, true);
        return;
    }
    if (state.graphVisible) closeGraphView();
    restoreListState(allNotes);
    state.view = 'list';
    state.noteID = null;
    elements.editorView.hidden = true;
    elements.newNote.hidden = false;
    document.body.classList.remove('is-editor-view');
    updateListHistory();
    await loadNotes();
    elements.searchInput.focus();
}

async function returnToList(listState, replace = false) {
    if (!(await flushSave())) return;
    const target = listState || { query: '', mode: 'title', folder: '', offset: 0 };
    if (replace) history.replaceState({ view: 'list', list: target }, '', location.pathname);
    state.view = 'list';
    state.noteID = null;
    resetBacklinks();
    resetOutline();
    document.body.classList.remove('is-editor-view');
    state.directEntry = false;
    restoreListState(target);
    elements.editorView.hidden = true;
    elements.graphView.hidden = !state.graphVisible;
    elements.searchView.hidden = state.graphVisible;
    elements.newNote.hidden = false;
    await loadNotes();
    if (elements.panel.dataset.panel === 'search') elements.searchInput.focus();
}

function restoreListState(listState) {
    elements.searchInput.value = listState.query || '';
    state.mode = listState.mode || 'title';
    state.folder = listState.folder || '';
    state.tag = listState.tag || '';
    state.offset = listState.offset || 0;
    state.graphVisible = Boolean(listState.graphVisible);
    document.body.classList.toggle('is-graph-view', state.graphVisible);
    elements.graphView.hidden = !state.graphVisible;
    elements.searchView.hidden = state.graphVisible;
    const graphButton = document.querySelector('#graphButton');
    graphButton.classList.toggle('is-active', state.graphVisible);
    graphButton.setAttribute('aria-pressed', String(state.graphVisible));
    if (state.graphVisible && state.graphData) {
        graphView.setGraph(state.graphData);
        updateGraphSummary(state.graphData);
        requestAnimationFrame(() => graphView.resize());
    } else if (state.graphVisible) {
        void openGraphView();
    }
    updateSearchModes();
    document.querySelector('#currentFolder').textContent = state.folder || 'Todas as notas';
}

async function handlePopState(event) {
    const target = event.state || { view: 'list', list: state.listState };
    if (state.view === 'editor' && !(await flushSave())) {
        history.forward();
        return;
    }
    if (target.view === 'editor' && target.noteId) {
        try {
            const note = await requestJSON(`/api/notes/${target.noteId}`);
            state.listState = target.list || state.listState || captureListState();
            state.directEntry = false;
            showEditor(note);
        } catch (error) {
            showMessage(`Não foi possível abrir a nota: ${error.message}`, 'error');
            history.forward();
        }
        return;
    }
    if (target.view === 'editor') {
        state.listState = target.list || state.listState || captureListState();
        state.directEntry = Boolean(target.direct);
        showEditor(null);
        return;
    }
    state.listState = target.list || state.listState;
    state.directEntry = false;
    state.view = 'list';
    document.body.classList.remove('is-editor-view');
    restoreListState(state.listState || {});
    state.noteID = null;
    resetBacklinks();
    resetOutline();
    elements.editorView.hidden = true;
    elements.graphView.hidden = !state.graphVisible;
    elements.searchView.hidden = state.graphVisible;
    elements.newNote.hidden = false;
    await loadNotes();
    if (elements.panel.dataset.panel === 'search') elements.searchInput.focus();
}

async function deleteCurrentNote() {
    if (state.noteID === null) return;
    if (!window.confirm(`Excluir “${elements.noteTitle.value}”? Essa ação não pode ser desfeita.`)) return;
    try {
        window.clearTimeout(state.saveTimer);
        if (state.savePromise) await state.savePromise;
        await requestJSON(`/api/notes/${state.noteID}`, { method: 'DELETE' });
        state.graphData = null;
        invalidateTable();
        state.savedDraft = getDraft();
        showMessage('Nota excluída.', 'success');
        state.noteID = null;
        resetBacklinks();
        resetOutline();
        state.folderNotesGeneration++;
        state.folderNotes.clear();
        navigateBack();
        void Promise.all([loadFolders(), loadNotes(), loadTags()]);
        void loadFolderNotes('', false);
    } catch (error) {
        setSaveStatus(`Não foi possível excluir: ${error.message}`, 'error');
    }
}

async function deleteNote(id) {
    const note = state.notes.find(item => item.id === id) ||
        [...state.folderNotes.values()].flatMap(page => page.items).find(item => item.id === id);
    if (!window.confirm(`Excluir “${note?.title || 'esta nota'}”? Essa ação não pode ser desfeita.`)) return;
    const deletingCurrent = state.view === 'editor' && state.noteID === id;
    try {
        if (deletingCurrent) {
            window.clearTimeout(state.saveTimer);
            if (state.savePromise) await state.savePromise;
        }
        await requestJSON(`/api/notes/${id}`, { method: 'DELETE' });
        state.graphData = null;
        invalidateTable();
        showMessage('Nota excluída.', 'success');
        state.folderNotesGeneration++;
        state.folderNotes.clear();
        if (deletingCurrent) {
            state.savedDraft = getDraft();
            state.noteID = null;
            resetBacklinks();
            resetOutline();
            if (state.directEntry) await returnToList(state.listState || captureListState(), true);
            else history.back();
            void Promise.all([loadFolders(), loadNotes(), loadTags()]);
            void loadFolderNotes('', false);
            return;
        }
        state.total = Math.max(0, state.total - 1);
        if (state.offset > 0 && state.offset >= state.total) state.offset = Math.max(0, state.offset - pageSize);
        await Promise.all([loadNotes(), loadFolders()]);
        await loadFolderNotes('', false);
    } catch (error) {
        showMessage(`Não foi possível excluir a nota: ${error.message}`, 'error');
    }
}

function updatePreview() {
    if (elements.editorWorkspace.dataset.editorMode === 'edit') {
        runPendingBacklink();
        return;
    }
    const requestID = ++previewRequestID;
    window.clearTimeout(previewTimer);
    const markdown = stripFrontmatter(elements.noteContent.value);
    if (!markdown.trim()) {
        elements.markdownPreview.textContent = '';
        renderFrontmatterProperties();
        renderedPreviewMarkdown = markdown;
        editorLinePositionCache = null;
        syncPreviewMinimumHeight();
        syncEditorScrollFromSource();
        runPendingBacklink();
        return;
    }
    previewTimer = window.setTimeout(async () => {
        try {
            const response = await fetch('/api/preview', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    ...(state.noteID === null ? {} : { 'X-Note-ID': String(state.noteID) })
                },
                body: markdown
            });
            if (response.status === 401) {
                location.replace('/login.html');
                return;
            }
            if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
            const html = await response.text();
            if (requestID === previewRequestID) {
                elements.markdownPreview.innerHTML = html;
                highlightPreviewCode();
                renderFrontmatterProperties();
                syncPreviewMinimumHeight();
                renderedPreviewMarkdown = markdown;
                annotatePreviewLandmarks(markdown);
                syncEditorScrollFromSource();
                if (state.pendingOutlineLine !== null) {
                    const pendingLine = state.pendingOutlineLine;
                    state.pendingOutlineLine = null;
                    requestAnimationFrame(() => scrollToOutlineHeading(pendingLine));
                }
                runPendingBacklink();
            }
        } catch (error) {
            if (requestID === previewRequestID) {
                elements.markdownPreview.textContent = `Falha ao renderizar Markdown: ${error.message}`;
                renderedPreviewMarkdown = '';
                renderFrontmatterProperties();
                syncPreviewMinimumHeight();
                syncEditorScrollFromSource();
            }
        }
    }, 140);
}

function renderFrontmatterProperties() {
    elements.markdownPreview.querySelector('.frontmatter-properties')?.remove();
    const metadata = parseFrontmatter(elements.noteContent.value);
    if (!metadata) return;

    const panel = document.createElement('section');
    panel.className = 'frontmatter-properties';
    panel.setAttribute('aria-label', 'Propriedades da nota');

    const tagsValue = metadata.tags;
    const tags = tagsValue === undefined || tagsValue === null
        ? []
        : (Array.isArray(tagsValue) ? tagsValue : [tagsValue]).map(String);
    const priority = ['date', 'created', 'author', 'status', 'priority', 'type', 'category'];
    const priorityFields = priority
        .filter(key => metadata[key] !== undefined && metadata[key] !== null && !Array.isArray(metadata[key]))
        .slice(0, 3);

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'frontmatter-summary';
    summary.dataset.frontmatterToggle = '';
    summary.setAttribute('aria-expanded', String(state.frontmatterExpanded));
    summary.setAttribute('aria-label', state.frontmatterExpanded
        ? 'Recolher propriedades da nota'
        : 'Expandir propriedades da nota');

    const summaryLabel = document.createElement('span');
    summaryLabel.className = 'frontmatter-summary-label';
    summaryLabel.textContent = '⚙ Propriedades';
    summary.append(summaryLabel);
    for (const tag of tags.slice(0, 5)) {
        const chip = document.createElement('span');
        chip.className = 'frontmatter-tag';
        chip.textContent = `#${tag}`;
        summary.append(chip);
    }
    if (tags.length > 5) {
        const more = document.createElement('span');
        more.className = 'frontmatter-muted';
        more.textContent = `+${tags.length - 5}`;
        summary.append(more);
    }
    for (const key of priorityFields) {
        const field = document.createElement('span');
        field.className = 'frontmatter-summary-field';
        field.textContent = `${key}: ${metadata[key]}`;
        summary.append(field);
    }
    const summaryChevron = document.createElement('span');
    summaryChevron.className = 'frontmatter-chevron';
    summaryChevron.textContent = '▼';
    summary.append(summaryChevron);
    if (!state.frontmatterExpanded) panel.append(summary);

    if (state.frontmatterExpanded) {
        const details = document.createElement('div');
        details.className = 'frontmatter-details';
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'frontmatter-details-header';
        header.dataset.frontmatterToggle = '';
        header.setAttribute('aria-expanded', 'true');
        header.textContent = '⚙ Propriedades · Recolher ▲';
        details.append(header);

        for (const [key, rawValue] of Object.entries(metadata)) {
            const row = document.createElement('div');
            row.className = 'frontmatter-row';
            const name = document.createElement('span');
            name.className = 'frontmatter-key';
            name.textContent = key;
            const value = document.createElement('span');
            value.className = 'frontmatter-value';
            const values = Array.isArray(rawValue) ? rawValue : [rawValue];
            value.textContent = values.map(item => item === null ? '' : String(item)).join(', ');
            row.append(name, value);
            details.append(row);
        }
        panel.append(details);
    }
    elements.markdownPreview.prepend(panel);
}

function syncPreviewMinimumHeight() {
    const preview = elements.markdownPreview;
    let spacer = preview.querySelector(':scope > .preview-scroll-spacer');
    if (elements.noteContent.clientHeight === 0 || preview.clientHeight === 0) {
        spacer?.remove();
        return;
    }
    const contentEnd = spacer ? spacer.previousElementSibling : preview.lastElementChild;
    const contentHeight = contentEnd
        ? Math.max(0, contentEnd.getBoundingClientRect().bottom - preview.getBoundingClientRect().top + preview.scrollTop)
        : 0;
    const neededHeight = getScrollSpacerHeight(
        Math.max(0, elements.noteContent.scrollHeight - elements.noteContent.clientHeight),
        contentHeight,
        preview.clientHeight
    );
    if (neededHeight > 0 && !spacer) {
        spacer = document.createElement('div');
        spacer.className = 'preview-scroll-spacer';
        preview.append(spacer);
    }
    if (spacer) {
        if (neededHeight > 0) spacer.style.height = `${neededHeight}px`;
        else spacer.remove();
    }
}

function scanMarkdownLandmarks(markdown) {
    const lines = markdown.split('\n');
    const landmarks = [];
    let fence = null;
    let inTable = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fenceMatch = line.match(/^ {0,3}(```+|~~~+)/);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
            landmarks.push({ line: index, kind: 'pre' });
            inTable = false;
            continue;
        }
        const heading = line.match(/^ {0,3}(#{1,6})\s+/);
        if (heading) {
            landmarks.push({ line: index, kind: `h${heading[1].length}` });
            inTable = false;
            continue;
        }
        if (index > 0 && /^ {0,3}(=+|-+)\s*$/.test(line) && lines[index - 1].trim()) {
            landmarks.push({ line: index - 1, kind: line.trim()[0] === '=' ? 'h1' : 'h2' });
            inTable = false;
            continue;
        }
        if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
            landmarks.push({ line: index, kind: 'hr' });
            inTable = false;
            continue;
        }
        if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) {
            landmarks.push({ line: index, kind: 'img' });
            inTable = false;
            continue;
        }
        const tableLine = /^\s*\|.*\|\s*$/.test(line);
        if (tableLine && !inTable) landmarks.push({ line: index, kind: 'table' });
        inTable = tableLine;
    }
    return landmarks;
}

function previewBlockKind(element) {
    if (/^H[1-6]$/.test(element.tagName)) return element.tagName.toLowerCase();
    if (element.tagName === 'PRE') return 'pre';
    if (element.tagName === 'HR') return 'hr';
    if (element.tagName === 'TABLE') return 'table';
    if (element.tagName === 'IMG' ||
        (element.tagName === 'P' && element.childNodes.length === 1 && element.firstElementChild?.tagName === 'IMG')) return 'img';
    return null;
}

function annotatePreviewLandmarks(markdown) {
    const byKind = new Map();
    for (const landmark of scanMarkdownLandmarks(markdown)) {
        if (!byKind.has(landmark.kind)) byKind.set(landmark.kind, []);
        byKind.get(landmark.kind).push(landmark);
    }
    const previewBlocks = [...elements.markdownPreview.children].map(element => ({
        element,
        kind: previewBlockKind(element)
    }));
    const previewByKind = new Map();
    for (const block of previewBlocks) {
        if (!block.kind) continue;
        if (!previewByKind.has(block.kind)) previewByKind.set(block.kind, []);
        previewByKind.get(block.kind).push(block.element);
    }
    for (const [kind, landmarks] of byKind) {
        const blocks = previewByKind.get(kind) || [];
        if (blocks.length !== landmarks.length) continue;
        blocks.forEach((element, index) => element.dataset.sourceLine = String(landmarks[index].line));
    }
}

function measureEditorLines(markdown, lines) {
    const editor = elements.noteContent;
    const computed = getComputedStyle(editor);
    const cacheKey = [
        markdown, editor.clientWidth, computed.fontFamily, computed.fontSize,
        computed.fontWeight, computed.lineHeight, computed.letterSpacing,
        computed.tabSize, computed.padding, [...lines].sort((a, b) => a - b).join(',')
    ].join('|');
    if (editorLinePositionCache?.key === cacheKey) return editorLinePositionCache.positions;

    const mirror = document.createElement('div');
    for (const property of [
        'direction', 'fontFamily', 'fontStyle', 'fontVariant', 'fontWeight',
        'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight',
        'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textAlign',
        'textTransform', 'textDecoration'
    ]) mirror.style[property] = computed[property];
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const paddingRight = parseFloat(computed.paddingRight) || 0;
    mirror.style.boxSizing = 'content-box';
    mirror.style.width = `${Math.max(0, editor.clientWidth - paddingLeft - paddingRight)}px`;
    mirror.style.padding = computed.padding;
    mirror.style.border = '0';
    mirror.style.height = 'auto';
    mirror.style.overflow = 'hidden';
    mirror.style.position = 'absolute';
    mirror.style.left = '-100000px';
    mirror.style.top = '0';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflowWrap = 'break-word';
    const wanted = new Set(lines);
    const sourceLines = markdown.split('\n');
    sourceLines.forEach((line, index) => {
        if (wanted.has(index)) {
            const marker = document.createElement('span');
            marker.dataset.line = String(index);
            marker.textContent = line || '\u200b';
            mirror.append(marker);
        } else {
            mirror.append(document.createTextNode(line));
        }
        if (index < sourceLines.length - 1) mirror.append(document.createTextNode('\n'));
    });
    document.body.append(mirror);
    const mirrorTop = mirror.getBoundingClientRect().top;
    const positions = new Map([...mirror.querySelectorAll('[data-line]')].map(marker => [
        Number(marker.dataset.line),
        marker.getBoundingClientRect().top - mirrorTop
    ]));
    mirror.remove();
    editorLinePositionCache = { key: cacheKey, positions };
    return positions;
}

function getScrollLandmarks() {
    const content = elements.noteContent.value;
    const markdown = stripFrontmatter(content);
    if (renderedPreviewMarkdown !== markdown) return [];
    const editor = elements.noteContent;
    const preview = elements.markdownPreview;
    const editorScrollable = Math.max(0, editor.scrollHeight - editor.clientHeight);
    const previewScrollable = Math.max(0, preview.scrollHeight - preview.clientHeight);
    if (!editorScrollable || !previewScrollable) return [];
    // Preview source lines are relative to the stripped body, but the editor
    // textarea still contains the frontmatter, so the measured line tops need
    // to be shifted by the removed lines to match the real editor scroll.
    const sourceLineOffset = frontmatterLineOffset(content);
    const sourceLines = [...elements.markdownPreview.querySelectorAll('[data-source-line]')]
        .map(element => Number(element.dataset.sourceLine));
    const positions = measureEditorLines(content, sourceLines.map(line => line + sourceLineOffset));
    const previewRect = preview.getBoundingClientRect();
    return [...elements.markdownPreview.querySelectorAll('[data-source-line]')]
        .map(element => {
            const sourceY = positions.get(Number(element.dataset.sourceLine) + sourceLineOffset);
            const previewTop = element.getBoundingClientRect().top - previewRect.top + preview.scrollTop;
            return {
                editorPct: Number.isFinite(sourceY) ? sourceY / editorScrollable : NaN,
                previewTop
            };
        })
        .filter(anchor => anchor.editorPct > 0 && anchor.editorPct < 1 &&
            anchor.previewTop > 0 && anchor.previewTop < previewScrollable);
}

function hasPreviewSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return elements.markdownPreview.contains(selection.getRangeAt(0).commonAncestorContainer);
}

function handleEditorScroll(source) {
    if (elements.editorWorkspace.dataset.editorMode !== 'split') return;
    if (source === elements.markdownPreview && hasPreviewSelection()) return;
    if (performance.now() < scrollSyncSuspendedUntil) {
        if (programmaticScroll?.element === source) programmaticScroll = null;
        return;
    }
    if (programmaticScroll?.element === source) {
        const matched = Math.abs(source.scrollTop - programmaticScroll.scrollTop) < 1;
        programmaticScroll = null;
        if (matched) return;
    }
    pendingScrollSource = source;
    if (scrollSyncFrame) return;
    scrollSyncFrame = requestAnimationFrame(() => {
        scrollSyncFrame = 0;
        const source = pendingScrollSource;
        pendingScrollSource = null;
        if (!source) return;
        const landmarks = getScrollLandmarks();
        const fromEditor = source === elements.noteContent;
        const sourceScrollable = Math.max(0, source.scrollHeight - source.clientHeight);
        const target = fromEditor ? elements.markdownPreview : elements.noteContent;
        const targetScrollable = Math.max(0, target.scrollHeight - target.clientHeight);
        const targetTop = fromEditor
            ? mapEditorToPreview(source.scrollTop, sourceScrollable, targetScrollable, landmarks)
            : mapPreviewToEditor(source.scrollTop, sourceScrollable, targetScrollable, landmarks);
        if (Math.abs(target.scrollTop - targetTop) >= 1) {
            programmaticScroll = { element: target, scrollTop: targetTop };
            target.scrollTop = targetTop;
        }
    });
}

function syncEditorScrollFromSource() {
    if (elements.editorWorkspace.dataset.editorMode !== 'split') return;
    if (hasPreviewSelection()) return;
    if (performance.now() < scrollSyncSuspendedUntil) return;
    const editor = elements.noteContent;
    const preview = elements.markdownPreview;
    const targetTop = mapEditorToPreview(
        editor.scrollTop,
        Math.max(0, editor.scrollHeight - editor.clientHeight),
        Math.max(0, preview.scrollHeight - preview.clientHeight),
        getScrollLandmarks()
    );
    if (Math.abs(preview.scrollTop - targetTop) >= 1) {
        programmaticScroll = { element: preview, scrollTop: targetTop };
        preview.scrollTop = targetTop;
    }
}

function updateEditorHistoryButtons({ canUndo, canRedo }) {
    document.querySelector('[data-action="undo"]').disabled = !canUndo;
    document.querySelector('[data-action="redo"]').disabled = !canRedo;
}

function setEditorMode(mode) {
    if (mode === 'split' && window.matchMedia('(max-width: 700px)').matches) mode = 'edit';
    if (elements.editorWorkspace.dataset.editorMode === mode) return;
    elements.editorWorkspace.dataset.editorMode = mode;
    localStorage.setItem('editorMode', mode);
    document.querySelectorAll('.editor-mode[data-editor-mode]').forEach(button => {
        const active = button.dataset.editorMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    if (mode === 'edit') {
        window.clearTimeout(previewTimer);
        previewRequestID++;
    } else {
        updatePreview();
    }
    requestAnimationFrame(() => {
        syncPreviewMinimumHeight();
        syncEditorScrollFromSource();
    });
}

function syncActiveRailButton() {
    const current = document.body.classList.contains('panel-open') ? elements.panel.dataset.panel : null;
    document.querySelectorAll('.rail-button[data-panel]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.panel === current);
    });
}

function togglePanel(name) {
    if (elements.panel.dataset.panel === name && document.body.classList.contains('panel-open')) {
        closePanel();
        return;
    }
    elements.panel.dataset.panel = name;
    document.body.classList.add('panel-open');
    syncActiveRailButton();
    if (name === 'backlinks') {
        elements.panelTitle.textContent = 'Backlinks';
        renderBacklinksPanel();
        if (state.noteID !== null && state.backlinks === null) void loadBacklinks(state.noteID);
    } else if (name === 'outline') {
        elements.panelTitle.textContent = 'Sumário';
        renderOutlinePanel();
    } else if (name === 'settings') {
        renderSettingsPanel();
    } else {
        elements.panelTitle.textContent = 'Pastas e notas';
        renderFolderPanel();
    }
}

function renderSettingsPanel() {
    elements.panelTitle.textContent = 'Configurações';

    const container = document.createElement('div');
    container.className = 'settings-panel';

    const section = document.createElement('section');
    section.className = 'settings-section';

    const heading = document.createElement('h3');
    heading.textContent = 'Backup e restauração';

    const description = document.createElement('p');
    description.className = 'settings-description';
    description.textContent = 'Baixe um arquivo .zip com todas as notas em Markdown, pastas, tags e anexos, ou restaure um backup substituindo os dados atuais.';

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.id = 'exportBackup';
    exportButton.className = 'button';
    exportButton.dataset.variant = 'muted';
    exportButton.textContent = 'Exportar backup';
    exportButton.addEventListener('click', () => void exportBackup(exportButton));

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.id = 'importBackup';
    importButton.className = 'button';
    importButton.dataset.variant = 'muted';
    importButton.textContent = 'Importar backup';
    importButton.addEventListener('click', () => elements.backupInput.click());

    actions.append(exportButton, importButton);
    section.append(heading, description, actions);
    container.append(section);
    elements.panelContent.replaceChildren(container);
}

function getWorkspacePanelWidthBounds() {
    const max = Math.max(220, Math.min(640, window.innerWidth - 40 - 80));
    return { min: Math.min(220, max), max };
}

function setWorkspacePanelWidth(width, persist = false) {
    const { min, max } = getWorkspacePanelWidthBounds();
    workspacePanelWidth = Math.round(Math.min(max, Math.max(min, width)));
    document.documentElement.style.setProperty('--workspace-panel-width', `${workspacePanelWidth}px`);
    elements.panelResizer.setAttribute('aria-valuemax', String(max));
    elements.panelResizer.setAttribute('aria-valuenow', String(workspacePanelWidth));
    if (persist) localStorage.setItem('workspacePanelWidth', String(workspacePanelWidth));
}

function startWorkspacePanelResize(event) {
    if (event.button !== 0 || window.matchMedia('(max-width: 700px)').matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-workspace-panel');
    resizeWorkspacePanel(event);
}

function resizeWorkspacePanel(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    setWorkspacePanelWidth(event.clientX - 40);
}

function stopWorkspacePanelResize(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('is-resizing-workspace-panel');
    setWorkspacePanelWidth(workspacePanelWidth, true);
}

function handleWorkspacePanelResizeKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = getWorkspacePanelWidthBounds();
    const width = event.key === 'Home' ? min
        : event.key === 'End' ? max
            : workspacePanelWidth + (event.key === 'ArrowRight' ? 20 : -20);
    setWorkspacePanelWidth(width, true);
}

function closePanel() {
    document.body.classList.remove('panel-open');
    syncActiveRailButton();
}

async function loadBacklinks(noteID) {
    const requestID = ++state.backlinksRequestID;
    state.backlinks = null;
    state.backlinksError = '';
    updateBacklinksCount();
    if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel();
    try {
        const backlinks = await requestJSON(`/api/notes/${noteID}/backlinks`);
        if (requestID !== state.backlinksRequestID || state.noteID !== noteID) return;
        if (!Array.isArray(backlinks)) throw new Error('resposta de backlinks inválida');
        state.backlinks = backlinks;
        state.backlinksError = '';
        updateBacklinksCount();
        if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel();
    } catch (error) {
        if (requestID !== state.backlinksRequestID || state.noteID !== noteID) return;
        state.backlinks = null;
        state.backlinksError = error.message;
        updateBacklinksCount();
        if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel('Não foi possível carregar os backlinks.');
        showMessage(`Não foi possível carregar os backlinks: ${error.message}`, 'error');
    }
}

function updateBacklinksCount() {
    const count = state.view === 'editor' && state.noteID !== null ? state.backlinks?.length || 0 : 0;
    elements.backlinksCount.textContent = count > 9 ? '9+' : String(count);
    elements.backlinksCount.hidden = count === 0;
    const label = count ? `Backlinks (${count})` : 'Abrir backlinks';
    document.querySelector('#backlinksButton').title = label;
    document.querySelector('#backlinksButton').setAttribute('aria-label', label);
}

function resetBacklinks() {
    state.backlinks = null;
    state.backlinksError = '';
    state.backlinksRequestID++;
    updateBacklinksCount();
    if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel();
}

function renderBacklinksPanel(errorMessage = '') {
    elements.panelContent.replaceChildren();
    if (state.view !== 'editor' || state.noteID === null) {
        const empty = document.createElement('div');
        empty.className = 'backlinks-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Abra uma nota para ver os backlinks.';
        empty.append(message);
        elements.panelContent.append(empty);
        return;
    }
    if (state.backlinksError || errorMessage) {
        const error = document.createElement('div');
        error.className = 'backlinks-panel-empty';
        const message = document.createElement('p');
        message.textContent = errorMessage || state.backlinksError;
        error.append(message);
        elements.panelContent.append(error);
        return;
    }
    if (state.backlinks === null) {
        const loading = document.createElement('div');
        loading.className = 'backlinks-panel-empty';
        loading.setAttribute('aria-label', 'Carregando backlinks');
        loading.append(...skeletonLines(3));
        elements.panelContent.append(loading);
        return;
    }
    if (state.backlinks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'backlinks-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Nenhuma nota aponta para esta nota.';
        empty.append(message);
        const hint = document.createElement('small');
        hint.textContent = 'Links [[wikilink]] e links Markdown são encontrados automaticamente.';
        empty.append(hint);
        elements.panelContent.append(empty);
        return;
    }
    for (const note of state.backlinks) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'backlink-item';
        item.dataset.backlinkNote = String(note.id);
        item.title = note.folder ? `${note.folder}/${note.title}` : note.title;
        const title = document.createElement('span');
        title.className = 'backlink-item-title';
        title.textContent = note.title;
        item.append(title);
        if (note.folder) {
            const folder = document.createElement('span');
            folder.className = 'backlink-item-folder';
            folder.textContent = note.folder;
            item.append(folder);
        }
        if (note.preview) {
            const preview = document.createElement('span');
            preview.className = 'backlink-item-preview';
            preview.textContent = note.preview;
            item.append(preview);
        }
        elements.panelContent.append(item);
    }
}

function refreshOutline() {
    state.outline = extractMarkdownOutline(elements.noteContent.value);
    updateOutlineCount();
    if (elements.panel.dataset.panel === 'outline') renderOutlinePanel();
}

function updateOutlineCount() {
    const count = state.view === 'editor' ? state.outline.length : 0;
    elements.outlineCount.textContent = count > 9 ? '9+' : String(count);
    elements.outlineCount.hidden = count === 0;
    const label = count ? `Sumário (${count})` : 'Abrir sumário da nota';
    document.querySelector('#outlineButton').title = label;
    document.querySelector('#outlineButton').setAttribute('aria-label', label);
}

function resetOutline() {
    state.outline = [];
    updateOutlineCount();
    if (elements.panel.dataset.panel === 'outline') renderOutlinePanel();
}

function renderOutlinePanel() {
    elements.panelContent.replaceChildren();
    if (state.view !== 'editor') {
        const empty = document.createElement('div');
        empty.className = 'outline-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Abra uma nota para ver o sumário.';
        empty.append(message);
        elements.panelContent.append(empty);
        return;
    }
    if (state.outline.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'outline-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Esta nota não tem títulos.';
        empty.append(message);
        elements.panelContent.append(empty);
        return;
    }
    for (const heading of state.outline) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'outline-item';
        item.dataset.outlineLine = String(heading.line);
        item.dataset.level = String(heading.level);
        item.style.paddingLeft = `${10 + (heading.level - 1) * 12}px`;
        item.textContent = heading.text;
        item.title = heading.text;
        elements.panelContent.append(item);
    }
}

function suspendScrollSync(duration = 350) {
    scrollSyncSuspendedUntil = performance.now() + duration;
}

function scrollEditorToLine(lineIndex) {
    const lineTop = measureEditorLines(elements.noteContent.value, [lineIndex]).get(lineIndex);
    if (!Number.isFinite(lineTop)) return false;
    const targetTop = Math.max(0, lineTop - 12);
    suspendScrollSync();
    programmaticScroll = { element: elements.noteContent, scrollTop: targetTop };
    elements.noteContent.scrollTop = targetTop;
    elements.noteContentHighlight.scrollTop = elements.noteContent.scrollTop;
    elements.noteContentHighlight.scrollLeft = elements.noteContent.scrollLeft;
    return true;
}

function scrollPreviewToElement(element, { offset = 12, flash = false } = {}) {
    const preview = elements.markdownPreview;
    const block = element.closest('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, table, img') || element;
    const targetTop = Math.max(0, Math.min(
        preview.scrollHeight - preview.clientHeight,
        preview.scrollTop + element.getBoundingClientRect().top - preview.getBoundingClientRect().top - offset
    ));
    suspendScrollSync();
    programmaticScroll = { element: preview, scrollTop: targetTop };
    preview.scrollTop = targetTop;
    if (flash) {
        block.classList.add('is-jump-target');
        window.setTimeout(() => block.classList.remove('is-jump-target'), 1600);
    }
}

function findPreviewHeading(heading) {
    const headings = [...elements.markdownPreview.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    return headings.find(element => Number(element.dataset.sourceLine) === heading.bodyLine) ||
        headings[state.outline.indexOf(heading)] ||
        headings.find(element => element.textContent.trim() === heading.text) ||
        null;
}

function runPendingBacklink() {
    const target = state.pendingBacklink;
    if (!target || state.view !== 'editor') return;
    state.pendingBacklink = null;
    const mode = elements.editorWorkspace.dataset.editorMode;
    const occurrence = findLinkOccurrence(elements.noteContent.value, target, state.noteFolder);
    if (mode !== 'preview' && occurrence) scrollEditorToLine(occurrence.line);
    if (mode === 'edit') return;
    requestAnimationFrame(() => {
        const anchor = [...elements.markdownPreview.querySelectorAll('a[href]')]
            .find(link => linkTargetMatches(link.getAttribute('href'), target, state.noteFolder));
        if (anchor) scrollPreviewToElement(anchor, { offset: 40, flash: true });
    });
}

function normalizeHeadingReference(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function scrollToLinkedHeading(reference) {
    const wanted = normalizeHeadingReference(reference);
    if (!wanted) return;
    const headings = state.outline;
    const heading = headings.find(item => normalizeHeadingReference(item.text) === wanted) ||
        headings.find(item => normalizeHeadingReference(item.text).startsWith(wanted)) ||
        headings.find(item => normalizeHeadingReference(item.text).includes(wanted));
    if (heading) scrollToOutlineHeading(heading.line);
}

function scrollToOutlineHeading(line) {
    const lineIndex = Number(line);
    const heading = state.outline.find(item => item.line === lineIndex);
    if (!heading) return;
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    const mode = elements.editorWorkspace.dataset.editorMode;
    if (mode !== 'edit' && renderedPreviewMarkdown !== stripFrontmatter(elements.noteContent.value)) {
        state.pendingOutlineLine = lineIndex;
        updatePreview();
        return;
    }
    if (mode !== 'preview') scrollEditorToLine(heading.line);
    if (mode !== 'edit') {
        const previewHeading = findPreviewHeading(heading);
        if (!previewHeading) return;
        requestAnimationFrame(() => scrollPreviewToElement(previewHeading));
    }
}

function renderFolderPanel() {
    const scrollTop = elements.panel.scrollTop;
    const rootRow = document.createElement('div');
    rootRow.className = 'tree-root-row';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = `tree-root${state.folder === '' ? ' is-selected' : ''}`;
    all.dataset.folder = '';
    all.textContent = 'Todas as notas';
    const actions = document.createElement('div');
    actions.className = 'tree-root-actions';
    const createNote = document.createElement('button');
    createNote.type = 'button';
    createNote.className = 'icon-button tree-root-action';
    createNote.dataset.createNote = '';
    createNote.setAttribute('aria-label', 'Criar nota');
    createNote.title = 'Criar nota';
    createNote.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const createFolder = document.createElement('button');
    createFolder.type = 'button';
    createFolder.className = 'icon-button tree-root-action';
    createFolder.dataset.createFolder = '';
    createFolder.setAttribute('aria-label', 'Criar pasta');
    createFolder.title = 'Criar pasta';
    createFolder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M16 11v6m-3-3h6"/></svg>';
    actions.append(createNote, createFolder);
    rootRow.append(all, actions);
    const root = document.createElement('section');
    root.className = 'tree-root-group';
    root.dataset.dropFolder = '';
    const rootHeader = document.createElement('div');
    rootHeader.className = 'tree-row';
    const rootExpand = makeExpandButton('', 'Notas sem pasta');
    const rootLabel = document.createElement('span');
    rootLabel.className = 'tree-group-label';
    rootLabel.textContent = 'Sem pasta';
    rootHeader.append(rootExpand, rootLabel);
    root.append(rootHeader);
    if (state.expandedFolders.has('')) root.append(renderDirectNotes('', true));
    const tree = document.createElement('ul');
    tree.className = 'folder-tree root-folder-tree';
    for (const folder of state.folders) tree.append(buildFolderNode(folder));
    elements.panelContent.replaceChildren(rootRow, root, tree);
    elements.panel.scrollTop = scrollTop;
}

function makeExpandButton(folderPath, label) {
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'tree-expand';
    expand.dataset.toggleFolder = folderPath;
    const expanded = state.expandedFolders.has(folderPath);
    expand.setAttribute('aria-label', `${expanded ? 'Recolher' : 'Expandir'} ${label}`);
    expand.setAttribute('aria-expanded', String(expanded));
    expand.textContent = '›';
    return expand;
}

function createTreeDocumentIcon(className) {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(namespace, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add(className);
    for (const [className, pathData] of [
        ['tree-document-page', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'],
        ['tree-document-fold', 'M14 2v6h6'],
        ['tree-document-lines', 'M16 13H8m8 4H8m5-8H8']
    ]) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', pathData);
        path.classList.add(className);
        icon.append(path);
    }
    return icon;
}

function createTreeFolderIcon(className) {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(namespace, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add(className);
    for (const [className, pathData] of [
        ['tree-folder-body', 'M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
        ['tree-folder-tab', 'M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2']
    ]) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', pathData);
        path.classList.add(className);
        icon.append(path);
    }
    return icon;
}

function buildFolderNode(folder) {
    const item = document.createElement('li');
    item.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.append(makeExpandButton(folder.path, folder.name));
    const select = document.createElement('button');
    select.type = 'button';
    select.className = `tree-folder${state.folder === folder.path ? ' is-selected' : ''}`;
    select.dataset.folder = folder.path;
    select.dataset.dragFolder = folder.path;
    select.draggable = true;
    const label = document.createElement('span');
    label.className = 'tree-folder-label';
    label.textContent = folder.name;
    select.append(createTreeFolderIcon('tree-folder-icon'), label);
    row.dataset.dropFolder = folder.path;
    row.append(select);
    const actions = document.createElement('div');
    actions.className = 'tree-folder-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'icon-button tree-folder-action';
    rename.dataset.renameFolder = folder.path;
    rename.setAttribute('aria-label', `Editar título de ${folder.name}`);
    rename.title = 'Editar título';
    rename.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg>';
    const createNote = document.createElement('button');
    createNote.type = 'button';
    createNote.className = 'icon-button tree-folder-action';
    createNote.dataset.createNoteFolder = folder.path;
    createNote.setAttribute('aria-label', `Criar nota em ${folder.path}`);
    createNote.title = `Criar nota em ${folder.path}`;
    createNote.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.75h8l4 4v12.5H6z"/><path d="M14 3.75v4h4M12 11v6m-3-3h6"/></svg>';
    const createSubfolder = document.createElement('button');
    createSubfolder.type = 'button';
    createSubfolder.className = 'icon-button tree-folder-action';
    createSubfolder.dataset.createSubfolder = folder.path;
    createSubfolder.setAttribute('aria-label', `Criar subpasta em ${folder.path}`);
    createSubfolder.title = `Criar subpasta em ${folder.path}`;
    createSubfolder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M16 11v6m-3-3h6"/></svg>';
    actions.append(rename, createNote, createSubfolder);
    row.append(actions);
    item.append(row);
    if (state.expandedFolders.has(folder.path)) {
        const contents = document.createElement('ul');
        contents.className = 'folder-tree';
        const directNotes = renderDirectNotes(folder.path, false);
        while (directNotes.firstChild) contents.append(directNotes.firstChild);
        for (const child of folder.children || []) contents.append(buildFolderNode(child));
        item.append(contents);
    }
    return item;
}

function renderDirectNotes(folder, root) {
    const list = document.createElement(root ? 'div' : 'ul');
    list.className = root ? 'tree-note-list root-note-list' : 'folder-tree-note-list';
    const page = state.folderNotes.get(folder);
    if (!page) {
        void loadFolderNotes(folder);
        const loading = document.createElement(root ? 'p' : 'li');
        loading.className = 'tree-loading';
        loading.setAttribute('aria-label', 'Carregando notas');
        loading.append(...skeletonLines(2));
        list.append(loading);
        return list;
    }
    for (const note of page.items) {
        const item = document.createElement(root ? 'div' : 'li');
        item.className = 'tree-note-item';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tree-note';
        button.dataset.treeNote = String(note.id);
        button.dataset.dragNote = String(note.id);
        button.draggable = true;
        button.title = note.title;
        const label = document.createElement('span');
        label.className = 'tree-note-label';
        label.textContent = note.title;
        button.append(createTreeDocumentIcon('tree-note-icon'), label);
        const actions = document.createElement('div');
        actions.className = 'tree-note-actions';
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'icon-button tree-note-action';
        rename.dataset.renameNote = String(note.id);
        rename.setAttribute('aria-label', `Editar título de ${note.title}`);
        rename.title = 'Editar título';
        rename.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg>';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-button tree-note-action tree-note-delete';
        remove.dataset.deleteTreeNote = String(note.id);
        remove.setAttribute('aria-label', `Excluir ${note.title}`);
        remove.title = 'Excluir nota';
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>';
        actions.append(rename, remove);
        item.append(button, actions);
        list.append(item);
    }
    if (page.items.length < page.total) {
        const item = document.createElement(root ? 'div' : 'li');
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tree-more';
        more.dataset.moreFolder = folder;
        more.textContent = 'Carregar mais notas';
        item.append(more);
        list.append(item);
    }
    if (!page.items.length) {
        const empty = document.createElement(root ? 'p' : 'li');
        empty.className = 'tree-loading';
        empty.textContent = 'Nenhuma nota nesta pasta';
        list.append(empty);
    }
    return list;
}

function handlePanelClick(event) {
    const createNoteFolder = event.target.closest('[data-create-note-folder]');
    if (createNoteFolder) {
        void openNewNote(createNoteFolder.dataset.createNoteFolder);
        return;
    }
    const createSubfolder = event.target.closest('[data-create-subfolder]');
    if (createSubfolder) {
        void createFolder(createSubfolder.dataset.createSubfolder);
        return;
    }
    if (event.target.closest('[data-create-note]')) {
        void openNewNote();
        return;
    }
    if (event.target.closest('[data-create-folder]')) {
        void createFolder();
        return;
    }
    const renameNote = event.target.closest('[data-rename-note]');
    if (renameNote) {
        event.preventDefault();
        event.stopPropagation();
        void renameNoteFromTree(Number(renameNote.dataset.renameNote));
        return;
    }
    const renameFolder = event.target.closest('[data-rename-folder]');
    if (renameFolder) {
        event.preventDefault();
        event.stopPropagation();
        void renameFolderFromTree(renameFolder.dataset.renameFolder);
        return;
    }
    const outlineItem = event.target.closest('[data-outline-line]');
    if (outlineItem) {
        scrollToOutlineHeading(outlineItem.dataset.outlineLine);
        return;
    }
    const backlink = event.target.closest('[data-backlink-note]');
    if (backlink) {
        const target = state.noteID === null
            ? null
            : {
                id: state.noteID,
                title: (state.savedDraft?.title || elements.noteTitle.value).trim(),
                folder: state.noteFolder
            };
        if (window.matchMedia('(max-width: 700px)').matches) closePanel();
        void openNote(Number(backlink.dataset.backlinkNote), { backlinkTarget: target });
        return;
    }
    const remove = event.target.closest('[data-delete-tree-note]');
    if (remove) {
        event.preventDefault();
        event.stopPropagation();
        void deleteNote(Number(remove.dataset.deleteTreeNote));
        return;
    }
    const toggle = event.target.closest('[data-toggle-folder]');
    if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.add('panel-open');
        const folder = toggle.dataset.toggleFolder;
        if (state.expandedFolders.has(folder)) state.expandedFolders.delete(folder);
        else {
            state.expandedFolders.add(folder);
            void loadFolderNotes(folder);
        }
        renderFolderPanel();
        return;
    }
    const more = event.target.closest('[data-more-folder]');
    if (more) {
        void loadFolderNotes(more.dataset.moreFolder, true);
        return;
    }
    const folderButton = event.target.closest('[data-folder]');
    if (folderButton) {
        void selectFolder(folderButton.dataset.folder);
        return;
    }
    const note = event.target.closest('[data-tree-note]');
    if (note) {
        void openNote(Number(note.dataset.treeNote));
    }
}

function handleSidebarDragStart(event) {
    const note = event.target.closest('[data-drag-note]');
    const folder = event.target.closest('[data-drag-folder]');
    const source = note || folder;
    if (!source || !event.dataTransfer) return;
    const type = note ? 'note' : 'folder';
    const value = note ? note.dataset.dragNote : folder.dataset.dragFolder;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(`application/x-pkm-${type}`, value);
    source.classList.add('is-dragging');
}

function handleSidebarDragOver(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (!target || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.classList.add('is-drop-target');
}

function handleSidebarDragLeave(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (target && !target.contains(event.relatedTarget)) target.classList.remove('is-drop-target');
}

function clearDropTargets() {
    elements.panelContent.querySelectorAll('.is-drop-target, .is-dragging').forEach(element => {
        element.classList.remove('is-drop-target', 'is-dragging');
    });
}

async function handleSidebarDrop(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (!target || !event.dataTransfer) return;
    event.preventDefault();
    const destinationParent = target.dataset.dropFolder;
    const noteID = event.dataTransfer.getData('application/x-pkm-note');
    const sourceFolder = event.dataTransfer.getData('application/x-pkm-folder');
    clearDropTargets();
    if (noteID) {
        await moveNoteToFolder(Number(noteID), destinationParent);
    } else if (sourceFolder) {
        await moveFolderToParent(sourceFolder, destinationParent);
    }
}

async function moveNoteToFolder(noteID, folder) {
    try {
        if (state.view === 'editor' && !(await flushSave())) return;
        await requestJSON(`/api/notes/${noteID}/folder`, {
            method: 'PATCH',
            body: JSON.stringify({ folder })
        });
        state.graphData = null;
        invalidateTable();
        if (state.view === 'editor' && state.noteID === noteID) {
            state.noteFolder = folder;
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
        }
        await refreshOpenNoteAfterMove();
        showMessage('Nota movida.', 'success');
        await refreshFolderTree();
        await loadNotes();
    } catch (error) {
        showMessage(`Não foi possível mover a nota: ${error.message}`, 'error');
    }
}

async function moveFolderToParent(source, target) {
    try {
        if (state.view === 'editor' && !(await flushSave())) return;
        const result = await requestJSON('/api/folders/move', {
            method: 'POST',
            body: JSON.stringify({ source, target })
        });
        state.graphData = null;
        invalidateTable();
        state.folder = rebaseFolderPath(state.folder, source, result.folder);
        if (state.listState) {
            state.listState.folder = rebaseFolderPath(state.listState.folder || '', source, result.folder);
        }
        if (state.view === 'editor' && (state.noteFolder === source || state.noteFolder.startsWith(`${source}/`))) {
            state.noteFolder = rebaseFolderPath(state.noteFolder, source, result.folder);
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
            const current = history.state || {};
            history.replaceState({ ...current, list: state.listState }, '', location.href);
        }
        await refreshOpenNoteAfterMove();
        showMessage('Pasta movida.', 'success');
        updateListHistory();
        await refreshFolderTree();
        await loadNotes();
    } catch (error) {
        showMessage(`Não foi possível mover a pasta: ${error.message}`, 'error');
    }
}

function rebaseFolderPath(folder, source, destination) {
    if (folder === source) return destination;
    return folder.startsWith(`${source}/`) ? destination + folder.slice(source.length) : folder;
}

async function refreshFolderTree() {
    state.folderNotesGeneration++;
    state.folderNotes.clear();
    await loadFolders();
    const folders = ['', ...state.expandedFolders].filter((folder, index, list) => list.indexOf(folder) === index);
    await Promise.all(folders.map(folder => loadFolderNotes(folder)));
}

async function renameNoteFromTree(noteID) {
    const isCurrent = state.view === 'editor' && state.noteID === noteID;
    if (isCurrent && !(await flushSave())) return;
    let note;
    try {
        note = isCurrent
            ? { title: elements.noteTitle.value, folder: state.noteFolder, content: elements.noteContent.value, version: state.noteVersion }
            : await requestJSON(`/api/notes/${noteID}`);
    } catch (error) {
        showMessage(`Não foi possível carregar a nota: ${error.message}`, 'error');
        return;
    }
    const value = window.prompt('Novo título da nota:', note.title);
    if (value === null) return;
    const title = value.trim();
    if (!title || title === note.title) return;
    try {
        if (isCurrent) {
            elements.noteTitle.value = title;
            if (!(await persistDraft())) return;
        } else {
            await requestJSON(`/api/notes/${noteID}`, {
                method: 'PUT',
                body: JSON.stringify({ ...note, title })
            });
            await refreshFolderTree();
            await loadNotes();
        }
        showMessage('Título da nota atualizado.', 'success');
    } catch (error) {
        showMessage(`Não foi possível renomear a nota: ${error.message}`, 'error');
    }
}

async function renameFolderFromTree(folder) {
    if (state.view === 'editor' && !(await flushSave())) return;
    const currentName = folder.split('/').pop();
    const value = window.prompt(`Novo nome da pasta “${currentName}”:`, currentName);
    if (value === null) return;
    const name = value.trim();
    if (!name || name === currentName) return;
    try {
        const result = await requestJSON('/api/folders/rename', {
            method: 'POST',
            body: JSON.stringify({ source: folder, name })
        });
        state.graphData = null;
        invalidateTable();
        state.folder = rebaseFolderPath(state.folder, folder, result.folder);
        state.expandedFolders = new Set(
            [...state.expandedFolders].map(path => rebaseFolderPath(path, folder, result.folder))
        );
        if (state.listState) {
            state.listState.folder = rebaseFolderPath(state.listState.folder || '', folder, result.folder);
        }
        if (state.view === 'editor' && (state.noteFolder === folder || state.noteFolder.startsWith(`${folder}/`))) {
            state.noteFolder = rebaseFolderPath(state.noteFolder, folder, result.folder);
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
            const current = history.state || {};
            history.replaceState({ ...current, list: state.listState }, '', location.href);
        }
        updateListHistory();
        await refreshFolderTree();
        await loadNotes();
        showMessage('Pasta renomeada.', 'success');
    } catch (error) {
        showMessage(`Não foi possível renomear a pasta: ${error.message}`, 'error');
    }
}

async function createFolder(parent = '') {
    const name = window.prompt(parent
        ? `Nome da subpasta em “${parent}” (use / para criar níveis):`
        : 'Nome da pasta (use / para criar subpastas):');
    if (name === null) return;
    const folderName = name.trim();
    if (!folderName) {
        showMessage('Informe um nome para a pasta.', 'error');
        return;
    }
    const folder = parent ? `${parent}/${folderName}` : folderName;
    try {
        await requestJSON('/api/folders', {
            method: 'POST',
            body: JSON.stringify({ path: folder })
        });
        const parts = folder.split('/');
        for (let index = 1; index <= parts.length; index++) {
            state.expandedFolders.add(parts.slice(0, index).join('/'));
        }
        void refreshFolderTree();
        showMessage('Pasta criada.', 'success');
    } catch (error) {
        showMessage(`Não foi possível criar a pasta: ${error.message}`, 'error');
    }
}

async function selectFolder(folder) {
    if (state.view === 'editor' && !(await flushSave())) return;
    if (state.graphVisible) closeGraphView();
    if (state.view === 'editor') {
        history.pushState({ view: 'list', list: { ...captureListState(), folder, offset: 0 } }, '', location.pathname);
        state.view = 'list';
        state.noteID = null;
        resetBacklinks();
        resetOutline();
        document.body.classList.remove('is-editor-view');
        elements.editorView.hidden = true;
        elements.searchView.hidden = false;
        elements.newNote.hidden = false;
    }
    state.folder = folder;
    state.offset = 0;
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    loadNotes();
    updateListHistory();
    if (elements.panel.dataset.panel === 'files') renderFolderPanel();
}

function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.content = bg;
}

function setupTheme() {
    const saved = localStorage.getItem('theme');
    document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
    syncThemeColor();
}

function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    syncThemeColor();
}

function buildCommandItems(query) {
    const themeLabel = document.documentElement.dataset.theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro';
    const commands = [
        {
            title: 'Nova nota',
            subtitle: 'Criar uma nota em branco',
            icon: 'plus',
            hint: 'Ctrl N',
            keywords: 'criar adicionar',
            run: () => openNewNote()
        },
        {
            title: 'Abrir grafo de notas',
            subtitle: 'Explorar relações e backlinks',
            icon: 'graph',
            keywords: 'relações conexões',
            run: () => openGraphView()
        },
        {
            title: 'Todas as notas',
            subtitle: 'Voltar para a lista principal',
            icon: 'list',
            keywords: 'início lista',
            run: () => showAllNotes()
        },
        {
            title: 'Pesquisar notas',
            subtitle: 'Ir para o campo de busca',
            icon: 'search',
            hint: '/',
            keywords: 'buscar procurar',
            run: () => showAllNotes()
        },
        {
            title: themeLabel,
            subtitle: 'Alternar entre claro e escuro',
            icon: 'theme',
            keywords: 'tema cores',
            run: () => toggleTheme()
        },
        {
            title: 'Exportar backup',
            subtitle: 'Baixar notas, pastas e anexos em .zip',
            icon: 'download',
            keywords: 'salvar baixar',
            run: () => exportBackup()
        },
        {
            title: 'Importar backup',
            subtitle: 'Restaurar um arquivo .zip',
            icon: 'upload',
            keywords: 'restaurar carregar',
            run: () => elements.backupInput.click()
        }
    ];
    const normalized = query.toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter(command =>
        `${command.title} ${command.subtitle || ''} ${command.keywords || ''}`
            .toLocaleLowerCase()
            .includes(normalized)
    );
}

async function loadCommandNotes(query) {
    const params = new URLSearchParams({ limit: '8', offset: '0' });
    let endpoint = '/api/notes';
    if (query) {
        params.set('q', query);
        params.set('mode', 'title');
        endpoint = '/api/search';
    }
    const page = await requestJSON(`${endpoint}?${params}`);
    return Array.isArray(page.items) ? page.items : [];
}

const messageIcons = {
    error: '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.1M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>',
    success: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8.5v.1"/></svg>'
};

function showMessage(message, kind = '') {
    window.clearTimeout(showMessage.clearTimer);
    elements.appMessage.replaceChildren();
    if (!message) return;
    const toast = document.createElement('div');
    toast.className = `toast${kind ? ` is-${kind}` : ''}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = messageIcons[kind] || messageIcons.info;
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fechar aviso');
    close.textContent = '×';
    close.addEventListener('click', () => {
        window.clearTimeout(showMessage.clearTimer);
        toast.remove();
    });
    toast.append(icon, text, close);
    elements.appMessage.append(toast);
    showMessage.clearTimer = window.setTimeout(() => {
        toast.remove();
    }, kind === 'success' ? 2800 : 6000);
}
