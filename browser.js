// Voice browser popup: search Fish's public library, play the free sample
// clips, save voices or put one straight on a character. Everything from
// Fish is user-written, so the DOM is built with textContent only.

import { characterLabel, el, LANGUAGES } from './dom.js';

const SORTS = [['task_count', 'Most used'], ['score', 'Recommended'], ['created_at', 'Newest']];
const PAGE_SIZE = 20;

/** @param {number} n */
function compact(n) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * @param {object} options
 * @param {(path: string) => Promise<any>} options.api Plugin API caller
 * @param {(id: string) => boolean} options.isSaved
 * @param {(voice: any) => Promise<boolean>} options.onSave
 * @param {boolean} options.canListOwn Whether a key is set, so "my voices" can be listed
 * @param {string[]} options.characters Voice map entries a voice can be put on
 * @param {(voice: any, character: string) => Promise<void>} options.onUseFor Saves the voice and assigns it
 */
export async function openVoiceBrowser({ api, isSaved, onSave, canListOwn, characters, onUseFor }) {
    const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
    const audio = new Audio();
    /** @type {HTMLElement|null} */
    let playingButton = null;

    const search = el('input', { type: 'search', className: 'text_pole fat-search', placeholder: 'Search voices by name' });
    const language = el('select', { className: 'text_pole' });
    language.append(new Option('Any language', ''), ...LANGUAGES.map(([value, label]) => new Option(label, value)));
    const sort = el('select', { className: 'text_pole' });
    sort.append(...SORTS.map(([value, label]) => new Option(label, value)));
    const mine = el('input', { type: 'checkbox', disabled: !canListOwn });
    const mineLabel = el('label', { className: 'checkbox_label', title: canListOwn ? '' : 'Save your API key first' }, mine, el('span', {}, 'Only my voices'));
    const go = el('div', { className: 'menu_button' }, 'Search');
    const info = el('small', { className: 'fat-browser-info' });
    const grid = el('div', { className: 'fat-grid' });
    const more = el('div', { className: 'menu_button fat-more', hidden: true }, 'Load more');
    const root = el('div', { className: 'fat-browser' },
        el('h3', {}, 'Fish Audio voices'),
        el('div', { className: 'fat-controls' }, search, language, sort, mineLabel, go),
        info, grid, more);

    let page = 1;
    let loading = false;
    // A new search replaces one still loading. Only the latest search's results are shown.
    let generation = 0;

    function stopSample() {
        audio.pause();
        playingButton?.classList.replace('fa-stop', 'fa-play');
        playingButton = null;
    }
    audio.addEventListener('ended', stopSample);

    /** @param {any} voice */
    function card(voice) {
        const placeholder = () => el('div', { className: 'fat-cover fat-cover-empty fa-solid fa-microphone' });
        const cover = voice.cover ? el('img', { className: 'fat-cover', src: voice.cover, alt: '', loading: 'lazy' }) : placeholder();
        cover.addEventListener('error', () => cover.replaceWith(placeholder()), { once: true });
        const meta = [voice.author && `by ${voice.author}`, voice.languages.join(', ')].filter(Boolean).join(' · ');
        const stats = `${compact(voice.uses)} uses · ${compact(voice.likes)} likes`;
        const tags = el('div', { className: 'fat-tags' }, ...voice.tags.slice(0, 6).map(t => el('span', { className: 'fat-tag' }, t)));

        const play = el('div', { className: 'menu_button fa-solid fa-play fat-icon-button', title: voice.sample ? 'Play free sample' : 'No sample available' });
        if (!voice.sample) play.classList.add('disabled');
        play.addEventListener('click', () => {
            if (!voice.sample) return;
            if (playingButton === play) return stopSample();
            stopSample();
            audio.src = voice.sample;
            audio.play().catch(() => stopSample());
            play.classList.replace('fa-play', 'fa-stop');
            playingButton = play;
        });

        const saved = isSaved(voice.id);
        const save = el('div', { className: 'menu_button fat-save' }, saved ? 'Saved' : 'Save');
        if (saved) save.classList.add('disabled');
        save.addEventListener('click', async () => {
            if (save.classList.contains('disabled')) return;
            save.classList.add('disabled');
            await onSave(voice);
            markSaved();
        });

        const markSaved = () => {
            save.textContent = 'Saved';
            save.classList.add('disabled');
        };
        const useFor = el('select', { className: 'text_pole fat-use-for', title: 'Save this voice and give it to a character' });
        useFor.append(new Option('Use for...', ''), ...characters.map(name => new Option(characterLabel(name), name)));
        useFor.hidden = !characters.length;
        useFor.addEventListener('change', async () => {
            if (!useFor.value) return;
            useFor.disabled = true;
            await onUseFor(voice, useFor.value);
            markSaved();
            useFor.value = '';
            useFor.disabled = false;
        });

        return el('div', { className: 'fat-card', title: voice.description },
            cover,
            el('div', { className: 'fat-card-body' },
                el('div', { className: 'fat-card-title' }, voice.title),
                el('small', {}, meta),
                el('small', {}, stats),
                tags,
                useFor),
            el('div', { className: 'fat-card-actions' }, play, save));
    }

    async function load(reset) {
        if (loading && !reset) return;
        const mine = ++generation;
        loading = true;
        if (reset) {
            page = 1;
            grid.replaceChildren();
            more.hidden = true;
        }
        info.textContent = 'Loading...';
        const params = new URLSearchParams({ page_size: String(PAGE_SIZE), page_number: String(page), sort_by: sort.value });
        if (search.value.trim()) params.set('title', search.value.trim());
        if (language.value) params.set('language', language.value);
        if (mine.checked) params.set('self', 'true');
        try {
            const data = await api(`/voices?${params}`);
            if (mine !== generation) return;
            grid.append(...data.items.map(card));
            const shown = grid.children.length;
            info.textContent = shown ? `${shown} voice${shown === 1 ? '' : 's'} shown. Samples are free to play.` : 'No voices found.';
            more.hidden = !data.hasMore;
            page++;
        } catch (error) {
            if (mine === generation) info.textContent = `Could not load voices: ${error.message}`;
        } finally {
            if (mine === generation) loading = false;
        }
    }

    go.addEventListener('click', () => load(true));
    search.addEventListener('keydown', (e) => e.key === 'Enter' && load(true));
    for (const control of [language, sort, mine]) control.addEventListener('change', () => load(true));
    more.addEventListener('click', () => load(false));

    load(true);
    await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    stopSample();
    audio.removeAttribute('src');
}
