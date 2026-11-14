const ICONS = {
    command: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2.5h8l4.5 4.5v15H5z"/><path d="M13 2.5V7h4.5M8 11h7m-7 3.5h7m-7 3.5h5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    graph: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="10" cy="18" r="2.2"/><path d="m8 6.3 7.8.4M7.3 8l2 7.8m7.2-6.7-5 7"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m7.5 9.2 1.5 1.5 3-3"/><path d="m7.5 15.2 1.5 1.5 3-3"/><path d="M14 9.5h3M14 15.5h3"/></svg>',
    theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3"/></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4L8 7M4 17v3h16v-3"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>'
};

function icon(name) {
    const wrapper = document.createElement('span');
    wrapper.className = 'command-icon';
    wrapper.innerHTML = ICONS[name] || ICONS.command;
    return wrapper;
}

export class CommandPalette {
    constructor({ dialog, input, list, loadNotes, getCommands, onNote, onError = () => {} }) {
        this.dialog = dialog;
        this.input = input;
        this.list = list;
        this.loadNotes = loadNotes;
        this.getCommands = getCommands;
        this.onNote = onNote;
        this.onError = onError;
        this.items = [];
        this.activeIndex = -1;
        this.requestID = 0;
        this.timer = null;
        this.query = '';
        this.bind();
    }

    bind() {
        this.input.addEventListener('input', () => this.schedule());
        this.input.addEventListener('keydown', event => this.handleKeydown(event));
        this.list.addEventListener('click', event => {
            const option = event.target.closest('[data-command-index]');
            if (option) void this.run(Number(option.dataset.commandIndex));
        });
        this.list.addEventListener('mousemove', event => {
            const option = event.target.closest('[data-command-index]');
            if (!option) return;
            const index = Number(option.dataset.commandIndex);
            if (index !== this.activeIndex) this.setActive(index, false);
        });
        this.dialog.addEventListener('click', event => {
            if (event.target === this.dialog) this.close();
        });
        this.dialog.addEventListener('close', () => this.reset());
        this.dialog.querySelector('[data-command-close]')?.addEventListener('click', () => this.close());
    }

    async open() {
        if (!this.dialog.open) this.dialog.showModal();
        this.input.value = '';
        this.query = '';
        this.items = [];
        this.activeIndex = -1;
        this.input.setAttribute('aria-expanded', 'true');
        this.render([], [], { loading: true });
        this.input.focus();
        await this.refresh('');
    }

    close() {
        if (this.dialog.open) this.dialog.close();
    }

    reset() {
        this.requestID++;
        window.clearTimeout(this.timer);
        this.items = [];
        this.activeIndex = -1;
        this.query = '';
        this.input.value = '';
        this.input.setAttribute('aria-expanded', 'false');
        this.input.removeAttribute('aria-activedescendant');
        this.list.replaceChildren();
    }

    schedule() {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.refresh(this.input.value.trim()), 120);
    }

    async refresh(query) {
        const requestID = ++this.requestID;
        this.query = query;
        this.activeIndex = 0;
        const commands = this.getCommands(query) || [];
        this.render(commands, [], { loading: true });
        try {
            const notes = await this.loadNotes(query);
            if (requestID !== this.requestID || !this.dialog.open) return;
            this.render(commands, Array.isArray(notes) ? notes : [], { loading: false });
        } catch (error) {
            if (requestID !== this.requestID || !this.dialog.open) return;
            this.render(commands, [], { loading: false, error: error.message });
        }
    }

    render(commands, notes, { loading = false, error = '' } = {}) {
        this.list.replaceChildren();
        this.items = [];

        if (commands.length) {
            this.list.append(this.groupLabel('Comandos'));
            for (const command of commands) {
                this.items.push(command);
                this.list.append(this.option(command, this.items.length - 1));
            }
        }

        if (loading) {
            this.list.append(this.groupLabel('Notas'));
            for (let index = 0; index < 3; index++) {
                const row = document.createElement('div');
                row.className = 'command-item command-skeleton';
                row.setAttribute('aria-hidden', 'true');
                const mark = document.createElement('span');
                mark.className = 'command-icon';
                const line = document.createElement('span');
                line.className = 'skeleton skeleton-line';
                line.style.width = `${45 + index * 12}%`;
                row.append(mark, line);
                this.list.append(row);
            }
        } else if (notes.length) {
            this.list.append(this.groupLabel('Notas'));
            for (const note of notes) {
                const item = {
                    title: note.title,
                    subtitle: note.folder || 'Sem pasta',
                    icon: 'note',
                    run: () => this.onNote(note)
                };
                this.items.push(item);
                this.list.append(this.option(item, this.items.length - 1));
            }
        }

        if (error) {
            const empty = document.createElement('p');
            empty.className = 'command-empty';
            empty.textContent = `Não foi possível buscar notas: ${error}`;
            this.list.append(empty);
        } else if (!loading && !this.items.length) {
            const empty = document.createElement('p');
            empty.className = 'command-empty';
            empty.textContent = this.query
                ? `Nenhum resultado para “${this.query}”.`
                : 'Nenhum comando disponível.';
            this.list.append(empty);
        }

        if (!this.items.length) {
            this.activeIndex = -1;
            this.input.removeAttribute('aria-activedescendant');
        } else {
            this.activeIndex = Math.min(this.activeIndex, this.items.length - 1);
            this.setActive(this.activeIndex, false);
        }
    }

    groupLabel(text) {
        const label = document.createElement('div');
        label.className = 'command-group-label';
        label.textContent = text;
        return label;
    }

    option(item, index) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'command-item';
        option.id = `command-option-${index}`;
        option.dataset.commandIndex = String(index);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === this.activeIndex));
        option.append(icon(item.icon));
        const text = document.createElement('span');
        text.className = 'command-text';
        const title = document.createElement('span');
        title.className = 'command-title';
        title.textContent = item.title;
        text.append(title);
        if (item.subtitle) {
            const subtitle = document.createElement('span');
            subtitle.className = 'command-subtitle';
            subtitle.textContent = item.subtitle;
            text.append(subtitle);
        }
        option.append(text);
        if (item.hint) {
            const hint = document.createElement('kbd');
            hint.className = 'kbd command-hint';
            hint.textContent = item.hint;
            option.append(hint);
        }
        return option;
    }

    setActive(index, scroll = true) {
        this.activeIndex = index;
        for (const [optionIndex, option] of [...this.list.querySelectorAll('[data-command-index]')].entries()) {
            const active = optionIndex === index;
            option.classList.toggle('is-active', active);
            option.setAttribute('aria-selected', String(active));
        }
        if (index >= 0 && this.items[index]) {
            this.input.setAttribute('aria-activedescendant', `command-option-${index}`);
            if (scroll) {
                this.list.querySelector(`#command-option-${index}`)?.scrollIntoView({ block: 'nearest' });
            }
        } else {
            this.input.removeAttribute('aria-activedescendant');
        }
    }

    move(delta) {
        if (!this.items.length) return;
        const index = (this.activeIndex + delta + this.items.length) % this.items.length;
        this.setActive(index);
    }

    handleKeydown(event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            this.move(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            this.setActive(event.key === 'Home' ? 0 : this.items.length - 1);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            void this.run(this.activeIndex);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            this.close();
        }
    }

    async run(index) {
        const item = this.items[index];
        if (!item) return;
        this.close();
        try {
            await item.run();
        } catch (error) {
            this.onError(error);
        }
    }
}
