// Fish Audio provider for SillyTavern's built-in TTS extension.
// Synthesis goes through the st-fish-audio-plugin server plugin, which holds
// the API key and streams audio back. generateTts returns the plugin's stream
// URL, which SillyTavern plays directly as the audio element's src.

import { getPreviewString, initVoiceMap, saveTtsProviderSettings } from '../../tts/index.js';
import { openVoiceBrowser } from './browser.js';
import {
    buildSpeakerRequest,
    buildTtsBody,
    buildVoiceObjects,
    compareVersions,
    formatBytes,
    formatCredit,
    hasSpeakerMarks,
    isVoiceId,
    markSpeakerLines,
    mergeSettings,
    MIN_PLUGIN_VERSION,
    MODEL_LABELS,
    MULTI_SPEAKER_MODELS,
    parseVoiceInput,
    PLUGIN_BASE,
    SECRET_KEY,
    SILENCE_URL,
    splitSpeakerSegments,
    toSavedVoice,
} from './lib.js';

// SillyTavern's voice map markers.
const DEFAULT_VOICE_MARKER = '[Default Voice]';
const DISABLED_VOICE_MARKER = 'disabled';

const OWN_VOICES_TTL_MS = 5 * 60_000;
const PLUGIN_URL = 'https://github.com/severian-dev/st-fish-audio-plugin';

class ApiError extends Error {
    /** @param {string} message @param {number} status */
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * Calls a plugin route. Errors carry the plugin's readable message.
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function pluginApi(path, init = {}) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const response = await fetch(`${PLUGIN_BASE}${path}`, { ...init, headers: getRequestHeaders() });
    let data = null;
    try {
        data = await response.json();
    } catch {
        // not JSON, e.g. SillyTavern's own 404 page when the plugin is missing
    }
    if (!response.ok) {
        throw new ApiError(data?.error || `HTTP ${response.status}`, response.status);
    }
    return data;
}

/** @param {string} url @param {object} body */
async function postSillyTavern(url, body) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const response = await fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

const SETTINGS_HTML = `
<div class="fat-settings">
    <div id="fat_status" class="fat-status"></div>
    <label for="fat_key">Fish API key</label>
    <div class="flex-container flexGap5 alignItemsCenter">
        <input id="fat_key" type="password" class="text_pole flex1" autocomplete="off" placeholder="Paste your Fish API key">
        <div id="fat_key_save" class="menu_button" title="Save key">Save</div>
        <div id="fat_key_remove" class="menu_button" title="Remove the saved key">Remove</div>
    </div>
    <small>Get a key at <a href="https://fish.audio/app/developers" target="_blank" rel="noopener">fish.audio/app/developers</a>. It is stored on the SillyTavern server, never sent back to the browser.</small>
    <label for="fat_model">Model</label>
    <select id="fat_model" class="text_pole"></select>
    <label for="fat_latency">Latency</label>
    <select id="fat_latency" class="text_pole">
        <option value="normal">Normal</option>
        <option value="balanced">Balanced (starts sooner)</option>
        <option value="low">Low (starts soonest)</option>
    </select>
    <label for="fat_speed">Speed <span id="fat_speed_out"></span></label>
    <input id="fat_speed" type="range" min="0.5" max="2" step="0.05">
    <label for="fat_temperature">Temperature <span id="fat_temperature_out"></span></label>
    <input id="fat_temperature" type="range" min="0" max="1" step="0.05">
    <label for="fat_top_p">Top P <span id="fat_top_p_out"></span></label>
    <input id="fat_top_p" type="range" min="0" max="1" step="0.05">
    <label class="checkbox_label" for="fat_normalize_loudness">
        <input id="fat_normalize_loudness" type="checkbox">
        <span>Even out loudness (S2 models)</span>
    </label>
    <div id="fat_cache_block" class="fat-cache" hidden>
        <label class="checkbox_label" for="fat_cache_audio">
            <input id="fat_cache_audio" type="checkbox">
            <span>Reuse audio for lines already spoken (saves credit)</span>
        </label>
        <div class="flex-container flexGap5 alignItemsCenter">
            <small id="fat_cache_stats" class="flex1"></small>
            <div id="fat_cache_clear" class="menu_button" title="Delete cached audio from the server">Clear</div>
        </div>
    </div>
    <h4 class="fat-heading">Voices</h4>
    <small>Saved voices show up in the voice map. Your own Fish voices are added automatically.</small>
    <div class="flex-container flexGap5">
        <div id="fat_browse" class="menu_button menu_button_icon"><i class="fa-solid fa-magnifying-glass"></i><span>Browse voices</span></div>
    </div>
    <div class="flex-container flexGap5 alignItemsCenter">
        <input id="fat_add_input" type="text" class="text_pole flex1" placeholder="Voice ID or fish.audio link">
        <div id="fat_add" class="menu_button">Add</div>
    </div>
    <div id="fat_saved" class="fat-saved"></div>
    <h4 class="fat-heading">Several voices in one message</h4>
    <label class="checkbox_label" for="fat_multi_speaker">
        <input id="fat_multi_speaker" type="checkbox">
        <span>Voice <code>Name:</code> lines with that character's voice</span>
    </label>
    <small>A line starting with a known name, like <code>Alice: "Hi"</code>, uses Alice's voice. Other lines use the
    message's voice. Names come from the voice map and the list below. Turn off "Only narrate quotes" and "Different
    voices for quotes" for this to work.</small>
    <div id="fat_speakers" class="fat-saved"></div>
    <div class="flex-container flexGap5">
        <div id="fat_speaker_add" class="menu_button menu_button_icon"><i class="fa-solid fa-plus"></i><span>Add name</span></div>
        <div id="fat_speaker_preview" class="menu_button menu_button_icon"><i class="fa-solid fa-eye"></i><span>Preview last message</span></div>
    </div>
</div>`;

export class FishAudioTtsProvider {
    settings = mergeSettings({});
    /** @type {{name: string, voice_id: string, lang: string, preview_url: string|false}[]} */
    voices = [];
    /** @type {any[]} */
    ownVoices = [];
    ownVoicesAt = 0;
    /** @type {{version: string, keySet: boolean, models: string[], defaultModel: string}|null} */
    status = null;
    statusError = '';
    credit = '';
    separator = ' ... ';
    previewAudio = new Audio();

    get settingsHtml() {
        return SETTINGS_HTML;
    }

    dispose() {
        this.previewAudio.pause();
    }

    /** @param {Record<string, any>} stored */
    async loadSettings(stored) {
        this.settings = mergeSettings(stored);
        this.bindUi();
        await this.refreshStatus();
        this.refreshCredit();
        this.refreshCache();
        this.renderSavedVoices();
        this.renderSpeakers();
    }

    async checkReady() {
        await this.refreshStatus();
        if (!this.status) throw this.statusError;
        if (!this.status.keySet) throw 'Add your Fish API key in the Fish Audio settings below.';
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        this.ownVoicesAt = 0;
        await this.refreshStatus();
        this.refreshCredit();
        this.refreshCache();
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async fetchTtsVoiceObjects() {
        const stale = Date.now() - this.ownVoicesAt > OWN_VOICES_TTL_MS;
        if (this.status?.keySet && stale) {
            try {
                const data = await pluginApi('/voices?self=true&page_size=100');
                this.ownVoices = data.items ?? [];
                this.ownVoicesAt = Date.now();
            } catch (error) {
                console.warn('[Fish Audio TTS] could not list your own voices:', error.message);
            }
        }
        this.voices = buildVoiceObjects(this.settings.savedVoices, this.ownVoices);
        return this.voices;
    }

    /** @param {string} name Label stored in the voice map, or a raw voice id */
    async getVoice(name) {
        if (!this.voices.length) await this.fetchTtsVoiceObjects();
        const match = this.voices.find(v => v.name === name);
        if (match) return match;
        if (isVoiceId(name)) return { name, voice_id: name, lang: '', preview_url: false };
        throw `Fish voice "${name}" not found. Save it in the Fish Audio settings.`;
    }

    /**
     * Runs before SillyTavern collapses line breaks, so speaker lines are
     * marked here while they are still lines.
     * @param {string} text
     */
    async processText(text) {
        if (!this.settings.multi_speaker) return text;
        if (!this.voices.length) await this.fetchTtsVoiceObjects();
        return markSpeakerLines(text, (name) => Boolean(this.speakerVoiceId(name)));
    }

    /**
     * @param {string} text
     * @param {string} voiceId
     * @returns {Promise<string|AsyncGenerator<string>>} URL that streams the audio, or one URL per turn
     */
    async generateTts(text, voiceId) {
        if (!hasSpeakerMarks(text)) return this.requestTts(text, voiceId);

        const request = buildSpeakerRequest(splitSpeakerSegments(text), (name) => this.speakerVoiceId(name), voiceId);
        if (!request.turns.length) return SILENCE_URL;
        if (request.voices.length === 1) return this.requestTts(request.text, request.voices[0]);
        if (MULTI_SPEAKER_MODELS.includes(this.settings.model)) return this.requestTts(request.text, request.voices);

        // Models without multi-speaker support get one clip per turn.
        const self = this;
        return (async function* () {
            for (const turn of request.turns) yield await self.requestTts(turn.text, turn.voiceId);
        })();
    }

    /**
     * @param {string} text
     * @param {string|string[]} voiceId One voice, or one per `<|speaker:N|>`
     */
    async requestTts(text, voiceId) {
        if (!String(text ?? '').trim()) return SILENCE_URL;
        try {
            const data = await pluginApi('/tts', {
                method: 'POST',
                body: JSON.stringify(buildTtsBody(text, voiceId, this.settings)),
            });
            return `${PLUGIN_BASE}/tts/${encodeURIComponent(data.id)}`;
        } catch (error) {
            // SillyTavern's TTS shows thrown strings as a toast.
            throw `Fish Audio: ${error.status === 404 ? this.missingPluginMessage() : error.message}`;
        }
    }

    /**
     * Voice id for a speaker name: the Speakers list first, then SillyTavern's
     * voice map (group members, the character itself). Case-insensitive.
     * @param {string} name
     * @returns {string|null}
     */
    speakerVoiceId(name) {
        const wanted = String(name).trim().toLowerCase();
        const byLabel = (label) => this.voices.find(v => v.name === label)?.voice_id ?? null;

        const listed = this.settings.speakers.find(s => s.name.trim().toLowerCase() === wanted);
        if (listed) return byLabel(listed.voice);

        const map = this.settings.voiceMap ?? {};
        const key = Object.keys(map).find(k => k.toLowerCase() === wanted);
        if (!key) return null;
        let label = map[key];
        if (label === DEFAULT_VOICE_MARKER) label = map[DEFAULT_VOICE_MARKER];
        if (!label || label === DISABLED_VOICE_MARKER || label === DEFAULT_VOICE_MARKER) return null;
        return byLabel(label);
    }

    /**
     * Plays a voice's free sample. Saved voices without a lasting sample link
     * get a fresh one from Fish. Only a voice with no sample at all costs a
     * generated preview line.
     */
    async previewTtsVoice(voiceId) {
        const voice = this.voices.find(v => v.voice_id === voiceId);
        try {
            let url = voice?.preview_url || null;
            if (!url && isVoiceId(voiceId)) {
                url = (await pluginApi(`/voices/${voiceId}`).catch(() => null))?.sample ?? null;
            }
            url ??= await this.generateTts(getPreviewString(voice?.lang || 'en-US'), voiceId);
            this.previewAudio.pause();
            this.previewAudio.src = url;
            await this.previewAudio.play();
        } catch (error) {
            toastr.error(String(error), 'Fish Audio TTS');
        }
    }

    missingPluginMessage() {
        return 'server plugin not found. Install st-fish-audio-plugin, set enableServerPlugins: true in config.yaml, then restart SillyTavern.';
    }

    async refreshStatus() {
        try {
            const status = await pluginApi('/status');
            if (compareVersions(status.version, MIN_PLUGIN_VERSION) < 0) {
                this.status = null;
                this.statusError = `Fish Audio server plugin v${status.version} is too old. Update it to v${MIN_PLUGIN_VERSION} or newer.`;
            } else {
                this.status = status;
                this.statusError = '';
            }
        } catch (error) {
            this.status = null;
            this.statusError = error.status === 404
                ? `Fish Audio ${this.missingPluginMessage()}`
                : `Could not reach the Fish Audio server plugin: ${error.message}`;
        }
        this.renderStatus();
        this.renderModels();
    }

    async refreshCredit() {
        this.credit = '';
        if (this.status?.keySet) {
            try {
                this.credit = formatCredit((await pluginApi('/credit')).credit);
            } catch {
                this.credit = 'unknown';
            }
        }
        this.renderStatus();
    }

    hasFeature(name) {
        return Boolean(this.status?.features?.includes(name));
    }

    async refreshCache() {
        const block = document.getElementById('fat_cache_block');
        if (!block) return;
        block.hidden = !this.hasFeature('cache');
        if (block.hidden) return;
        const stats = await pluginApi('/cache').catch(() => null);
        $('#fat_cache_stats').text(stats ? `${stats.files} clip${stats.files === 1 ? '' : 's'} cached, ${formatBytes(stats.bytes)}` : '');
    }

    async clearCache() {
        try {
            await pluginApi('/cache', { method: 'DELETE' });
            toastr.info('Cached audio cleared.', 'Fish Audio TTS');
        } catch (error) {
            toastr.error(`Could not clear the cache: ${error.message}`, 'Fish Audio TTS');
        }
        this.refreshCache();
    }

    renderStatus() {
        const box = document.getElementById('fat_status');
        if (!box) return;
        box.replaceChildren();
        box.classList.toggle('fat-status-bad', !this.status || !this.status.keySet);
        if (!this.status) {
            box.append(this.statusError, ' ');
            const link = Object.assign(document.createElement('a'), { href: PLUGIN_URL, target: '_blank', rel: 'noopener', textContent: 'Setup steps' });
            box.append(link);
            return;
        }
        const parts = [`Plugin v${this.status.version} connected.`];
        parts.push(this.status.keySet ? 'Key saved.' : 'No API key yet.');
        if (this.status.keySet && this.credit) parts.push(`API credit: ${this.credit}.`);
        box.textContent = parts.join(' ');
    }

    renderModels() {
        const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('fat_model'));
        if (!select) return;
        const models = this.status?.models?.length ? this.status.models : Object.keys(MODEL_LABELS);
        if (!models.includes(this.settings.model)) {
            this.settings.model = this.status?.defaultModel ?? models[0];
        }
        select.replaceChildren(...models.map(id => new Option(MODEL_LABELS[id] ?? id, id)));
        select.value = this.settings.model;
    }

    renderSavedVoices() {
        const box = document.getElementById('fat_saved');
        if (!box) return;
        box.replaceChildren();
        if (!this.settings.savedVoices.length) {
            box.append(Object.assign(document.createElement('small'), { textContent: 'No saved voices yet. Browse Fish\'s library or paste a voice ID.' }));
            return;
        }
        for (const voice of this.settings.savedVoices) {
            const row = document.createElement('div');
            row.className = 'fat-saved-row';
            if (voice.cover) {
                const img = Object.assign(document.createElement('img'), { src: voice.cover, alt: '', loading: 'lazy' });
                img.className = 'fat-cover-small';
                row.append(img);
            }
            const name = document.createElement('div');
            name.className = 'fat-saved-name';
            name.textContent = voice.label;
            name.title = `${voice.title}\n${voice.id}`;
            const langs = Object.assign(document.createElement('small'), { textContent: voice.languages.join(', ') });
            row.append(name, langs);

            const play = this.iconButton('fa-play', 'Play sample');
            play.addEventListener('click', () => this.previewTtsVoice(voice.id));
            const remove = this.iconButton('fa-trash-can', 'Remove from saved voices');
            remove.addEventListener('click', () => this.removeVoice(voice.id));
            row.append(play, remove);
            box.append(row);
        }
    }

    renderSpeakers() {
        const box = document.getElementById('fat_speakers');
        if (!box) return;
        box.replaceChildren();
        const labels = this.settings.savedVoices.map(v => v.label);
        this.settings.speakers.forEach((speaker, index) => {
            const row = document.createElement('div');
            row.className = 'fat-saved-row';
            const name = Object.assign(document.createElement('input'), {
                type: 'text', className: 'text_pole flex1', value: speaker.name, placeholder: 'Name before the colon',
            });
            name.addEventListener('input', () => {
                speaker.name = name.value.trim();
                saveTtsProviderSettings();
            });
            const voice = document.createElement('select');
            voice.className = 'text_pole flex1';
            const options = labels.includes(speaker.voice) || !speaker.voice ? labels : [speaker.voice, ...labels];
            voice.append(new Option('Pick a saved voice', ''), ...options.map(l => new Option(l, l)));
            voice.value = speaker.voice;
            voice.addEventListener('change', () => {
                speaker.voice = voice.value;
                saveTtsProviderSettings();
            });
            const remove = this.iconButton('fa-trash-can', 'Remove this name');
            remove.addEventListener('click', () => {
                this.settings.speakers.splice(index, 1);
                saveTtsProviderSettings();
                this.renderSpeakers();
            });
            row.append(name, voice, remove);
            box.append(row);
        });
    }

    addSpeaker() {
        this.settings.speakers.push({ name: '', voice: '' });
        saveTtsProviderSettings();
        this.renderSpeakers();
        $('#fat_speakers input').last().trigger('focus');
    }

    /** Shows how the last chat message would be split between voices. Generates nothing. */
    async previewLastMessage() {
        const { chat, callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
        const message = [...(chat ?? [])].reverse().find(m => !m.is_system && m.mes);
        if (!message) {
            toastr.info('No message to preview yet.', 'Fish Audio TTS');
            return;
        }
        if (!this.voices.length) await this.fetchTtsVoiceObjects();
        const marked = markSpeakerLines(String(message.mes).replaceAll('*', ''), (name) => Boolean(this.speakerVoiceId(name)));
        const fallback = this.settings.voiceMap?.[message.name] ?? DEFAULT_VOICE_MARKER;
        const request = buildSpeakerRequest(splitSpeakerSegments(marked), (name) => this.speakerVoiceId(name), '__message__');
        const voiceName = (id) => (id === '__message__' ? `${message.name}'s voice (${fallback})` : this.voices.find(v => v.voice_id === id)?.name ?? id);

        const root = document.createElement('div');
        root.className = 'fat-preview';
        root.append(Object.assign(document.createElement('h3'), { textContent: `Voices for ${message.name}'s last message` }));
        for (const turn of request.turns) {
            const row = document.createElement('div');
            row.className = 'fat-preview-turn';
            row.append(
                Object.assign(document.createElement('b'), { textContent: voiceName(turn.voiceId) }),
                Object.assign(document.createElement('div'), { textContent: turn.text }),
            );
            root.append(row);
        }
        const note = !this.settings.multi_speaker
            ? 'Several voices is off, so the whole message uses one voice.'
            : request.voices.length > 1 && !MULTI_SPEAKER_MODELS.includes(this.settings.model)
                ? 'This model can\'t mix voices in one request, so each turn is sent on its own.'
                : request.voices.length > 1 ? `${request.voices.length} voices, sent as one request.` : 'One voice for the whole message.';
        root.append(Object.assign(document.createElement('small'), { textContent: note }));
        await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    }

    /** @param {string} icon @param {string} title */
    iconButton(icon, title) {
        const button = document.createElement('div');
        button.className = `menu_button fa-solid ${icon} fat-icon-button`;
        button.title = title;
        return button;
    }

    /** @param {{id: string, title: string, languages?: string[], sample?: string|null, cover?: string|null}} voice */
    async saveVoice(voice) {
        if (this.settings.savedVoices.some(v => v.id === voice.id)) return false;
        this.settings.savedVoices.push(toSavedVoice(voice, this.settings.savedVoices));
        await this.voicesChanged();
        return true;
    }

    /** @param {string} id */
    async removeVoice(id) {
        this.settings.savedVoices = this.settings.savedVoices.filter(v => v.id !== id);
        await this.voicesChanged();
    }

    async voicesChanged() {
        saveTtsProviderSettings();
        this.renderSavedVoices();
        this.renderSpeakers();
        this.voices = buildVoiceObjects(this.settings.savedVoices, this.ownVoices);
        await initVoiceMap();
    }

    async addFromInput() {
        const input = /** @type {HTMLInputElement} */ (document.getElementById('fat_add_input'));
        const id = parseVoiceInput(input.value);
        if (!id) {
            toastr.warning('Paste a 32-character voice ID or a fish.audio voice link.', 'Fish Audio TTS');
            return;
        }
        try {
            const voice = await pluginApi(`/voices/${id}`);
            const added = await this.saveVoice(voice);
            input.value = '';
            toastr.success(added ? `Saved "${voice.title}".` : 'That voice is already saved.', 'Fish Audio TTS');
        } catch (error) {
            toastr.error(error.message, 'Fish Audio TTS');
        }
    }

    async saveKey() {
        const input = /** @type {HTMLInputElement} */ (document.getElementById('fat_key'));
        const value = input.value.trim();
        if (!value) {
            toastr.warning('Paste your Fish API key first.', 'Fish Audio TTS');
            return;
        }
        try {
            await this.clearKey();
            await postSillyTavern('/api/secrets/write', { key: SECRET_KEY, value, label: 'Fish Audio' });
            input.value = '';
            this.ownVoicesAt = 0;
            await this.refreshStatus();
            this.refreshCredit();
            await initVoiceMap();
            toastr.success('Fish API key saved.', 'Fish Audio TTS');
        } catch (error) {
            toastr.error(`Could not save the key: ${error.message}`, 'Fish Audio TTS');
        }
    }

    async removeKey() {
        try {
            await this.clearKey();
            this.ownVoices = [];
            await this.refreshStatus();
            this.refreshCredit();
            await initVoiceMap();
            toastr.info('Fish API key removed.', 'Fish Audio TTS');
        } catch (error) {
            toastr.error(`Could not remove the key: ${error.message}`, 'Fish Audio TTS');
        }
    }

    /** SillyTavern keeps every key written under a name. Clear them all so exactly one is active. */
    async clearKey() {
        for (let i = 0; i < 20; i++) {
            const status = await pluginApi('/status').catch(() => null);
            if (!status?.keySet) return;
            await postSillyTavern('/api/secrets/delete', { key: SECRET_KEY });
        }
    }

    bindUi() {
        const s = this.settings;
        const $model = $('#fat_model');
        $model.on('change', () => {
            s.model = String($model.val());
            saveTtsProviderSettings();
        });
        $('#fat_latency').val(s.latency).on('change', function () {
            s.latency = String($(this).val());
            saveTtsProviderSettings();
        });
        for (const key of ['speed', 'temperature', 'top_p']) {
            const $out = $(`#fat_${key}_out`).text(s[key]);
            $(`#fat_${key}`).val(s[key]).on('input', function () {
                s[key] = Number($(this).val());
                $out.text(s[key]);
                saveTtsProviderSettings();
            });
        }
        $('#fat_normalize_loudness').prop('checked', s.normalize_loudness).on('change', function () {
            s.normalize_loudness = Boolean($(this).prop('checked'));
            saveTtsProviderSettings();
        });
        $('#fat_cache_audio').prop('checked', s.cache_audio).on('change', function () {
            s.cache_audio = Boolean($(this).prop('checked'));
            saveTtsProviderSettings();
        });
        $('#fat_cache_clear').on('click', () => this.clearCache());
        $('#fat_multi_speaker').prop('checked', s.multi_speaker).on('change', function () {
            s.multi_speaker = Boolean($(this).prop('checked'));
            saveTtsProviderSettings();
        });
        $('#fat_speaker_add').on('click', () => this.addSpeaker());
        $('#fat_speaker_preview').on('click', () => this.previewLastMessage());

        $('#fat_key_save').on('click', () => this.saveKey());
        $('#fat_key_remove').on('click', () => this.removeKey());
        $('#fat_key').on('keydown', (e) => e.key === 'Enter' && this.saveKey());
        $('#fat_add').on('click', () => this.addFromInput());
        $('#fat_add_input').on('keydown', (e) => e.key === 'Enter' && this.addFromInput());
        $('#fat_browse').on('click', () => openVoiceBrowser({
            api: pluginApi,
            isSaved: (id) => this.settings.savedVoices.some(v => v.id === id),
            onSave: (voice) => this.saveVoice(voice),
            canListOwn: Boolean(this.status?.keySet),
        }));
    }
}
