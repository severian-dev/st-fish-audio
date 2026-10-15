// Voice designer popup. Describe a voice, or draft the description from the
// character card with the user's own chat model, then audition Fish's
// candidates and save one as a private voice on the user's Fish account.
// Fish charges $0.01 per design request. Saving takes about 15 seconds.

import { characterLabel, DEFAULT_VOICE_MARKER, el, LANGUAGES } from './dom.js';
import { buildBriefPrompt, cleanBrief, pickPreviewLine, PLUGIN_BASE } from './lib.js';

/**
 * @param {object} options
 * @param {(path: string, init?: RequestInit) => Promise<any>} options.api Plugin API caller
 * @param {string[]} options.characters Voice map entries
 * @param {string} options.defaultCharacter
 * @param {(voice: any, character: string) => Promise<string>} options.onSaved Saves and assigns, returns the voice label
 */
export async function openVoiceDesigner({ api, characters, defaultCharacter, onSaved }) {
    const context = SillyTavern.getContext();
    const named = characters.filter(n => n !== DEFAULT_VOICE_MARKER);
    const audio = new Audio();

    const character = el('select', { className: 'text_pole' });
    character.append(...characters.map(name => new Option(characterLabel(name), name)));
    character.value = characters.includes(defaultCharacter) ? defaultCharacter : (named[0] ?? characters[0] ?? '');
    const draft = el('div', { className: 'menu_button menu_button_icon', title: 'Uses your connected chat model' },
        el('i', { className: 'fa-solid fa-wand-magic-sparkles' }), el('span', {}, 'Draft from character card'));
    const brief = el('textarea', {
        className: 'text_pole', rows: 3, maxLength: 2000,
        placeholder: 'Gender, age, accent, pitch, tone, pace. For example: a gentle woman in her twenties, warm and calm, soft and a little breathy.',
    });
    const line = el('input', { type: 'text', className: 'text_pole', maxLength: 150, placeholder: 'What the candidates say (up to 150 characters)' });
    const language = el('select', { className: 'text_pole' });
    language.append(new Option('Auto language', ''), ...LANGUAGES.map(([value, label]) => new Option(label, value)));
    const count = el('select', { className: 'text_pole' });
    count.append(...[2, 3, 4].map(n => new Option(`${n} candidates`, String(n))));
    count.value = '3';
    const go = el('div', { className: 'menu_button menu_button_icon' }, el('i', { className: 'fa-solid fa-microphone-lines' }), el('span', {}, 'Design voices'));
    const status = el('small', { className: 'fat-browser-info' }, 'Fish charges $0.01 per design, however many candidates.');
    const results = el('div', { className: 'fat-candidates' });

    const root = el('div', { className: 'fat-browser fat-designer' },
        el('h3', {}, 'Design a voice'),
        el('label', {}, 'For'),
        el('div', { className: 'fat-controls' }, character, draft),
        el('label', {}, 'Describe the voice'),
        brief,
        el('label', {}, 'Preview line'),
        line,
        el('div', { className: 'fat-controls' }, language, count, go),
        status,
        results);

    /** Card fields for a chat member, macros filled in. The user's own entry uses their persona. */
    function card(name) {
        const fill = (text) => context.substituteParams(String(text ?? ''), undefined, name);
        if (name === context.name1) {
            return { name, description: fill(context.powerUserSettings?.persona_description) };
        }
        const found = (context.characters ?? []).find(c => c?.name === name);
        return found ? {
            name,
            description: fill(found.description ?? found.data?.description),
            personality: fill(found.personality ?? found.data?.personality),
            scenario: fill(found.scenario ?? found.data?.scenario),
            firstMessage: fill(found.first_mes ?? found.data?.first_mes),
        } : { name };
    }

    let lineTouched = false;
    line.addEventListener('input', () => { lineTouched = true; });
    const fillLine = () => {
        if (!lineTouched) line.value = pickPreviewLine(card(character.value).firstMessage);
    };
    character.addEventListener('change', fillLine);
    fillLine();

    draft.addEventListener('click', async () => {
        const info = card(character.value);
        if (!info.description && !info.personality) {
            toastr.warning(`${characterLabel(character.value)} has no description to draft from. Describe the voice yourself.`, 'Fish Audio TTS');
            return;
        }
        draft.classList.add('disabled');
        status.textContent = 'Drafting with your chat model...';
        try {
            const { prompt, systemPrompt } = buildBriefPrompt(info);
            const text = cleanBrief(await context.generateRaw({ prompt, systemPrompt, responseLength: 200 }));
            if (!text) throw new Error('the model returned nothing');
            brief.value = text;
            status.textContent = 'Draft ready. Edit it if you like, then design.';
        } catch (error) {
            status.textContent = `Couldn't draft: ${error?.message ?? error}. Connect a chat model, or describe the voice yourself.`;
        } finally {
            draft.classList.remove('disabled');
        }
    });

    /** @param {string} id @param {any} candidate */
    function candidateCard(id, candidate) {
        const play = el('div', { className: 'menu_button fa-solid fa-play fat-icon-button', title: 'Play' });
        play.addEventListener('click', () => {
            audio.pause();
            audio.src = `${PLUGIN_BASE}/design/${encodeURIComponent(id)}/${candidate.index}`;
            audio.play().catch(() => {});
        });
        const use = el('div', { className: 'menu_button' }, 'Use this voice');
        use.addEventListener('click', async () => {
            if (use.classList.contains('disabled')) return;
            const who = character.value;
            for (const b of results.querySelectorAll('.menu_button')) b.classList.add('disabled');
            status.textContent = 'Saving to your Fish account. This takes about 15 seconds...';
            try {
                const title = who === DEFAULT_VOICE_MARKER ? 'Designed voice' : `${who} (designed)`;
                const voice = await api(`/design/${encodeURIComponent(id)}/${candidate.index}/save`, {
                    method: 'POST',
                    body: JSON.stringify({ title }),
                });
                const label = await onSaved(voice, who);
                status.textContent = `Saved as "${label}" and set as ${characterLabel(who)}'s voice.`;
                use.textContent = 'Saved';
            } catch (error) {
                status.textContent = `Couldn't save: ${error?.message ?? error}`;
                for (const b of results.querySelectorAll('.menu_button')) b.classList.remove('disabled');
            }
        });
        return el('div', { className: 'fat-card fat-candidate' },
            el('div', { className: 'fat-card-body' },
                el('div', { className: 'fat-card-title' }, `Candidate ${candidate.index + 1}`),
                el('div', { className: 'fat-tags' }, ...candidate.traits.map(t => el('span', { className: 'fat-tag' }, t))),
                el('small', { className: 'fat-wrap' }, candidate.description)),
            el('div', { className: 'fat-card-actions' }, play, use));
    }

    go.addEventListener('click', async () => {
        if (go.classList.contains('disabled')) return;
        if (!brief.value.trim()) {
            toastr.warning('Describe the voice first, or draft it from the character card.', 'Fish Audio TTS');
            return;
        }
        go.classList.add('disabled');
        results.replaceChildren();
        status.textContent = 'Designing...';
        try {
            const data = await api('/design', {
                method: 'POST',
                body: JSON.stringify({
                    instruction: brief.value.trim(),
                    reference_text: line.value.trim() || undefined,
                    language: language.value || undefined,
                    n: Number(count.value),
                }),
            });
            results.append(...data.candidates.map(c => candidateCard(data.id, c)));
            status.textContent = 'Listen, then pick one. Saving puts it on your Fish account as a private voice.';
        } catch (error) {
            status.textContent = `Couldn't design: ${error?.message ?? error}`;
        } finally {
            go.classList.remove('disabled');
        }
    });

    await callPopup(root);
    audio.pause();
    audio.removeAttribute('src');

    /** @param {HTMLElement} content */
    async function callPopup(content) {
        const { callGenericPopup, POPUP_TYPE } = context;
        await callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: 'Close' });
    }
}
