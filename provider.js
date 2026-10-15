// Fish Audio provider for SillyTavern's built-in TTS extension.
// Synthesis goes through the st-fish-audio-plugin server plugin, which holds
// the API key and streams audio back. generateTts returns the plugin's stream
// URL, which SillyTavern plays directly as the audio element's src.

import { getPreviewString, initVoiceMap, sanitizeId, saveTtsProviderSettings } from '../../tts/index.js';
import { openVoiceBrowser } from './browser.js';
import { openVoiceDesigner } from './designer.js';
import {
    buildSpeakerRequest,
    buildTtsBody,
    buildVoiceObjects,
    compareVersions,
    CUE_DISPLAY_REGEX,
    cueInstruction,
    estimateCost,
    formatBytes,
    formatCredit,
    hasSpeakerMarks,
    isVoiceId,
    keepDialogue,
    markSpeakerLines,
    mergeSettings,
    MIN_PLUGIN_VERSION,
    MODEL_LABELS,
    MULTI_SPEAKER_MODELS,
    MUTED,
    parseTagList,
    parseVoiceInput,
    PLUGIN_BASE,
    PROVIDER_NAME,
    removeUnspoken,
    rewriteCues,
    SECRET_KEY,
    SILENCE_URL,
    SLOW_MODELS,
    splitIntoChunks,
    splitSpeakerSegments,
    toSavedVoice,
} from './lib.js';

// SillyTavern's voice map markers.
const DEFAULT_VOICE_MARKER = '[Default Voice]';
const DISABLED_VOICE_MARKER = 'disabled';
// SillyTavern prompt injection: in chat, depth 1, system role.
const CUE_PROMPT_KEY = 'fish_audio_tts_cues';
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;
const CUE_SCRIPT_NAME = 'Fish Audio TTS: hide voice cues';
const AI_OUTPUT = 2;

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
    <label class="checkbox_label" for="fat_smooth_slow">
        <input id="fat_smooth_slow" type="checkbox">
        <span>Smooth playback for Drama 3 (prepares sentences ahead so playback doesn't stutter)</span>
    </label>
    <div id="fat_warnings" class="fat-warnings"></div>
    <h4 class="fat-heading">What gets read</h4>
    <label class="checkbox_label" for="fat_read_narration">
        <input id="fat_read_narration" type="checkbox">
        <span>Read narration (off reads only dialogue: quoted text and <code>Name:</code> lines)</span>
    </label>
    <label class="checkbox_label" for="fat_skip_markup">
        <input id="fat_skip_markup" type="checkbox">
        <span>Skip infoboxes and markup (code blocks, tables, HTML blocks, comments)</span>
    </label>
    <label for="fat_skip_tags">Also skip these tags</label>
    <input id="fat_skip_tags" type="text" class="text_pole" placeholder="infobox, status, stats">
    <small>Reasoning blocks like <code>&lt;think&gt;</code> are never read. Mute a speaker in the list below.
    Preview last message shows what will be read and what it costs.</small>
    <h4 class="fat-heading">Voices</h4>
    <small>Saved voices show up in the voice map. Your own Fish voices are added automatically.</small>
    <div class="flex-container flexGap5">
        <div id="fat_browse" class="menu_button menu_button_icon"><i class="fa-solid fa-magnifying-glass"></i><span>Browse voices</span></div>
        <div id="fat_design" class="menu_button menu_button_icon" hidden title="Create a new voice from a description or the character card. $0.01 per design."><i class="fa-solid fa-wand-magic-sparkles"></i><span>Design a voice</span></div>
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
    <h4 class="fat-heading">Voice cues</h4>
    <label class="checkbox_label" for="fat_cues">
        <input id="fat_cues" type="checkbox">
        <span>Use cues like <code>[whispering]</code> (off removes them before speaking)</span>
    </label>
    <label class="checkbox_label" for="fat_cue_prompt">
        <input id="fat_cue_prompt" type="checkbox">
        <span>Ask the chat model to write cues</span>
    </label>
    <label class="checkbox_label" for="fat_cue_hide">
        <input id="fat_cue_hide" type="checkbox">
        <span>Hide cues in the chat (adds a display-only regex script)</span>
    </label>
    <small>S2 models and Drama 3 read free-form cues. S1 only knows a fixed set, so other cues are dropped for it.</small>
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

    /** SillyTavern clears extension prompts whenever a chat loads, so the cue instruction is re-applied. */
    reapplyCuePrompt = () => this.applyCuePrompt();

    /** SillyTavern TTS options that undo what this provider does, with what to use instead. */
    renderWarnings() {
        const box = document.getElementById('fat_warnings');
        if (!box) return;
        const tts = SillyTavern.getContext().extensionSettings.tts ?? {};
        const warnings = [];
        if (tts.skip_tags && this.settings.model === 'drama-3') {
            warnings.push('"Skip <tagged> blocks" above deletes the words inside Drama 3 tags like <whisper>. Turn it off and use "Skip infoboxes" below.');
        }
        if (tts.narrate_quoted_only && this.settings.multi_speaker) {
            warnings.push('"Only narrate quotes" above drops Name: labels, so speakers can\'t get their own voices. Turn it off and untick "Read narration" below.');
        }
        if (tts.multi_voice_enabled && this.settings.multi_speaker) {
            warnings.push('"Different voices for quotes" above splits lines before speakers are found. Turn it off to use the Speakers list.');
        }
        box.replaceChildren(...warnings.map(w => Object.assign(document.createElement('div'), { className: 'fat-warning', textContent: w })));
    }

    dispose() {
        this.previewAudio.pause();
        const { eventSource, eventTypes, setExtensionPrompt } = SillyTavern.getContext();
        eventSource.removeListener(eventTypes.CHAT_CHANGED, this.reapplyCuePrompt);
        eventSource.removeListener(eventTypes.GENERATION_STARTED, this.reapplyCuePrompt);
        $(document).off('change.fat');
        setExtensionPrompt(CUE_PROMPT_KEY, '', IN_CHAT, 1, false, SYSTEM_ROLE);
    }

    /**
     * Keeps the cue instruction in the prompt while it's wanted. The filter
     * runs at every prompt build, so it drops out as soon as TTS is off or
     * another provider is picked.
     */
    applyCuePrompt() {
        const context = SillyTavern.getContext();
        const value = this.settings.cue_prompt ? cueInstruction(this.settings.model) : '';
        context.setExtensionPrompt(CUE_PROMPT_KEY, value, IN_CHAT, 1, false, SYSTEM_ROLE, () => {
            const tts = SillyTavern.getContext().extensionSettings.tts;
            return Boolean(this.settings.cue_prompt && tts?.enabled && tts.currentProvider === PROVIDER_NAME);
        });
    }

    cueScriptInstalled() {
        const scripts = SillyTavern.getContext().extensionSettings.regex;
        return Array.isArray(scripts) && scripts.some(s => s?.scriptName === CUE_SCRIPT_NAME);
    }

    /** Adds or removes a global, display-only regex script that hides cues in chat messages. @param {boolean} on */
    async setCueScript(on) {
        const context = SillyTavern.getContext();
        const scripts = Array.isArray(context.extensionSettings.regex) ? context.extensionSettings.regex : [];
        const rest = scripts.filter(s => s?.scriptName !== CUE_SCRIPT_NAME);
        if (on) {
            rest.push({
                id: crypto.randomUUID(),
                scriptName: CUE_SCRIPT_NAME,
                findRegex: CUE_DISPLAY_REGEX,
                replaceString: '',
                trimStrings: [],
                placement: [AI_OUTPUT],
                disabled: false,
                markdownOnly: true,
                promptOnly: false,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
        }
        context.extensionSettings.regex = rest;
        context.saveSettingsDebounced();
        await context.reloadCurrentChat();
        toastr.info(on ? `Added the regex script "${CUE_SCRIPT_NAME}".` : 'Removed the cue-hiding regex script.', 'Fish Audio TTS');
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
        this.renderWarnings();
        this.applyCuePrompt();
        const { eventSource, eventTypes } = SillyTavern.getContext();
        eventSource.on(eventTypes.CHAT_CHANGED, this.reapplyCuePrompt);
        eventSource.on(eventTypes.GENERATION_STARTED, this.reapplyCuePrompt);
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
                const before = this.ownVoices.map(v => v.id).join();
                this.ownVoices = data.items ?? [];
                this.ownVoicesAt = Date.now();
                // Own voices are speaker choices too. Only redraw when they change, so typing isn't interrupted.
                if (before !== this.ownVoices.map(v => v.id).join()) {
                    this.voices = buildVoiceObjects(this.settings.savedVoices, this.ownVoices);
                    this.renderSpeakers();
                }
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
        const s = this.settings;
        let out = removeUnspoken(text, { skipMarkup: s.skip_markup, extraTags: parseTagList(s.skip_tags) });
        if (s.multi_speaker) {
            if (!this.voices.length) await this.fetchTtsVoiceObjects();
            out = markSpeakerLines(out, (name) => this.speakerVoiceId(name) !== null);
        }
        if (!s.read_narration) out = keepDialogue(out);
        return rewriteCues(out, s.model, s.cues);
    }

    /**
     * @param {string} text
     * @param {string} voiceId
     * @returns {Promise<string|AsyncGenerator<string>>} URL that streams the audio, or one URL per turn
     */
    async generateTts(text, voiceId) {
        const request = hasSpeakerMarks(text)
            ? buildSpeakerRequest(splitSpeakerSegments(text), (name) => this.speakerVoiceId(name), voiceId)
            : { voices: [voiceId], text, turns: [{ voiceId, speaker: null, text }] };
        if (!request.turns.length || !request.text.trim()) return SILENCE_URL;

        // Drama 3 generates at about real time or slower, so one long streamed
        // clip can stall mid-sentence. Instead the text goes out as sentence
        // chunks, all generating at once. The short first chunk starts playing
        // soon, and each later one has had a head start by the time it plays.
        if (this.settings.smooth_slow && SLOW_MODELS.includes(this.settings.model)) {
            const chunks = request.turns.flatMap(t => splitIntoChunks(t.text).map(chunk => ({ text: chunk, voiceId: t.voiceId })));
            return this.smoothStream(chunks);
        }
        if (request.voices.length === 1) return this.requestTts(request.text, request.voices[0]);
        if (MULTI_SPEAKER_MODELS.includes(this.settings.model)) return this.requestTts(request.text, request.voices);

        // Models without multi-speaker support get one clip per turn.
        const self = this;
        return (async function* () {
            for (const turn of request.turns) yield await self.requestTts(turn.text, turn.voiceId);
        })();
    }

    /**
     * Starts chunks a few at a time, ahead of playback, and yields their
     * stream URLs in order.
     * @param {{text: string, voiceId: string}[]} chunks
     */
    async *smoothStream(chunks) {
        // The plugin allows 5 Fish requests at once, so 4 ahead leaves room for previews.
        const AHEAD = 4;
        /** @type {Promise<string>[]} */
        const started = [];
        const startMore = (played) => {
            while (started.length < chunks.length && started.length < played + AHEAD) {
                const chunk = chunks[started.length];
                const promise = this.requestTts(chunk.text, chunk.voiceId);
                promise.catch(() => {}); // awaited in order below
                started.push(promise);
            }
        };
        for (let i = 0; i < chunks.length; i++) {
            startMore(i);
            yield await started[i];
        }
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
     * MUTED for speakers muted in the list or disabled in the voice map.
     * @param {string} name
     * @returns {string|null}
     */
    speakerVoiceId(name) {
        const wanted = String(name).trim().toLowerCase();
        const byLabel = (label) => this.voices.find(v => v.name === label)?.voice_id ?? null;

        const listed = this.settings.speakers.find(s => s.name.trim().toLowerCase() === wanted);
        if (listed) return listed.voice === MUTED ? MUTED : byLabel(listed.voice);

        const map = this.settings.voiceMap ?? {};
        const key = Object.keys(map).find(k => k.toLowerCase() === wanted);
        if (!key) return null;
        let label = map[key];
        if (label === DEFAULT_VOICE_MARKER) label = map[DEFAULT_VOICE_MARKER];
        if (label === DISABLED_VOICE_MARKER) return MUTED;
        if (!label || label === DEFAULT_VOICE_MARKER) return null;
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
        $('#fat_design').prop('hidden', !this.hasFeature('design'));
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
        const labels = buildVoiceObjects(this.settings.savedVoices, this.ownVoices).map(v => v.name);
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
            const options = labels.includes(speaker.voice) || !speaker.voice || speaker.voice === MUTED ? labels : [speaker.voice, ...labels];
            voice.append(new Option('Pick a voice', ''), new Option('Muted (not read)', MUTED), ...options.map(l => new Option(l, l)));
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

    /**
     * What SillyTavern's TTS does to a message before processText, roughly,
     * so the preview matches what gets read.
     * @param {string} mes
     */
    coreLikePrep(mes) {
        const tts = SillyTavern.getContext().extensionSettings.tts ?? {};
        let text = String(mes);
        if (tts.skip_codeblocks) text = text.replace(/```.*?```/gs, '').replace(/~~~.*?~~~/gs, '');
        if (tts.skip_tags) text = text.replace(/<.*?>[\s\S]*?<\/.*?>/g, '');
        if (!tts.pass_asterisks) {
            text = tts.narrate_dialogues_only ? text.replace(/\*[^*]*?(\*|$)/g, '') : text.replaceAll('*', '');
        }
        return text;
    }

    /** Shows what the last chat message would read, in which voices, and the rough cost. Generates nothing. */
    async previewLastMessage() {
        const { chat, callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
        const message = [...(chat ?? [])].reverse().find(m => !m.is_system && m.mes);
        if (!message) {
            toastr.info('No message to preview yet.', 'Fish Audio TTS');
            return;
        }
        if (!this.voices.length) await this.fetchTtsVoiceObjects();
        const spoken = (await this.processText(this.coreLikePrep(message.mes))).replace(/\s+/g, ' ').trim();
        const own = '__message__';
        const request = hasSpeakerMarks(spoken)
            ? buildSpeakerRequest(splitSpeakerSegments(spoken), (name) => this.speakerVoiceId(name), own)
            : { voices: spoken ? [own] : [], turns: spoken ? [{ voiceId: own, speaker: null, text: spoken }] : [] };
        const fallback = this.settings.voiceMap?.[message.name] ?? DEFAULT_VOICE_MARKER;
        const voiceName = (id) => (id === own ? `${message.name}'s voice (${fallback})` : this.voices.find(v => v.voice_id === id)?.name ?? id);

        const root = document.createElement('div');
        root.className = 'fat-preview';
        root.append(Object.assign(document.createElement('h3'), { textContent: `What gets read from ${message.name}'s last message` }));
        if (!request.turns.length) {
            root.append(Object.assign(document.createElement('div'), { textContent: 'Nothing. Every part of this message is skipped or muted.' }));
        }
        for (const turn of request.turns) {
            const row = document.createElement('div');
            row.className = 'fat-preview-turn';
            row.append(
                Object.assign(document.createElement('b'), { textContent: voiceName(turn.voiceId) }),
                Object.assign(document.createElement('div'), { textContent: turn.text }),
            );
            root.append(row);
        }
        const model = this.settings.model;
        const cost = estimateCost(request.turns.map(t => t.text).join(' '), model);
        const price = cost.usd === null ? '' : cost.usd === 0 ? ', free on this model' : `, about $${cost.usd.toFixed(4)} on this model`;
        const original = estimateCost(String(message.mes), model).bytes;
        const notes = [`${cost.bytes} of ${original} bytes read${price}.`];
        if (!this.settings.multi_speaker) notes.push('Several voices is off, so the whole message uses one voice.');
        else if (request.voices.length > 1) {
            notes.push(MULTI_SPEAKER_MODELS.includes(model)
                ? `${request.voices.length} voices, sent as one request.`
                : 'This model can\'t mix voices in one request, so each turn is sent on its own.');
        }
        if (this.settings.smooth_slow && SLOW_MODELS.includes(model)) notes.push('Drama 3 sends it sentence by sentence, prepared ahead.');
        if (model === 'drama-3') notes.push('Drama 3\'s price isn\'t published. The estimate uses $10 per 1M bytes, measured in October 2026.');
        root.append(Object.assign(document.createElement('small'), { textContent: notes.join(' ') }));
        await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    }

    /** @param {string} icon @param {string} title */
    iconButton(icon, title) {
        const button = document.createElement('div');
        button.className = `menu_button fa-solid ${icon} fat-icon-button`;
        button.title = title;
        return button;
    }

    /**
     * Adds a voice to the saved list unless it's there already.
     * @param {{id: string, title: string, languages?: string[], sample?: string|null, cover?: string|null}} voice
     * @returns {Promise<{label: string, added: boolean}>}
     */
    async saveVoice(voice) {
        const existing = this.settings.savedVoices.find(v => v.id === voice.id);
        if (existing) return { label: existing.label, added: false };
        const saved = toSavedVoice(voice, this.settings.savedVoices);
        this.settings.savedVoices.push(saved);
        await this.voicesChanged();
        return { label: saved.label, added: true };
    }

    /** Names in SillyTavern's voice map for the current chat, "[Default Voice]" first. */
    voiceMapCharacters() {
        return [...document.querySelectorAll('#tts_voicemap_block .tts_voicemap_block_char > span')]
            .map(span => span.textContent ?? '')
            .filter(Boolean);
    }

    /**
     * Picks a voice for a character through SillyTavern's own voice map
     * dropdown, so its save logic runs as if the user had picked it.
     * @param {string} character Voice map entry name
     * @param {string} label Saved voice label
     */
    assignVoice(character, label) {
        const select = $(`#tts_voicemap_char_${sanitizeId(character)}_voice`);
        if (!select.length || !select.find('option').toArray().some(o => o.value === label)) return false;
        select.val(label).trigger('change');
        return true;
    }

    /**
     * Saves a voice if needed and gives it to a character.
     * @param {any} voice Voice from the plugin
     * @param {string} character Voice map entry name
     * @returns {Promise<string>} The voice's label
     */
    async useVoiceFor(voice, character) {
        const { label } = await this.saveVoice(voice);
        if (this.assignVoice(character, label)) {
            toastr.success(`"${label}" now voices ${character === DEFAULT_VOICE_MARKER ? 'everyone without their own voice' : character}.`, 'Fish Audio TTS');
        } else {
            toastr.info(`Saved "${label}". Pick it for ${character} in the voice map.`, 'Fish Audio TTS');
        }
        return label;
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
            const { added } = await this.saveVoice(voice);
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
            this.applyCuePrompt();
            this.renderWarnings();
        });
        // SillyTavern's own TTS options can undo ours, so warnings follow them.
        $(document).off('change.fat').on('change.fat', '#tts_skip_tags, #tts_narrate_quoted, #tts_multi_voice_enabled', () => {
            setTimeout(() => this.renderWarnings(), 0);
        });
        for (const key of ['smooth_slow', 'read_narration', 'skip_markup']) {
            $(`#fat_${key}`).prop('checked', s[key]).on('change', (e) => {
                s[key] = Boolean($(e.currentTarget).prop('checked'));
                saveTtsProviderSettings();
            });
        }
        $('#fat_skip_tags').val(s.skip_tags).on('input', (e) => {
            s.skip_tags = String($(e.currentTarget).val());
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
        $('#fat_multi_speaker').prop('checked', s.multi_speaker).on('change', (e) => {
            s.multi_speaker = Boolean($(e.currentTarget).prop('checked'));
            saveTtsProviderSettings();
            this.renderWarnings();
        });
        $('#fat_speaker_add').on('click', () => this.addSpeaker());
        $('#fat_cues').prop('checked', s.cues).on('change', function () {
            s.cues = Boolean($(this).prop('checked'));
            saveTtsProviderSettings();
        });
        $('#fat_cue_prompt').prop('checked', s.cue_prompt).on('change', (e) => {
            s.cue_prompt = Boolean($(e.currentTarget).prop('checked'));
            saveTtsProviderSettings();
            this.applyCuePrompt();
        });
        $('#fat_cue_hide').prop('checked', this.cueScriptInstalled()).on('change', (e) => {
            this.setCueScript(Boolean($(e.currentTarget).prop('checked')));
        });
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
            characters: this.voiceMapCharacters(),
            onUseFor: async (voice, character) => { await this.useVoiceFor(voice, character); },
        }));
        $('#fat_design').on('click', () => {
            const characters = this.voiceMapCharacters();
            if (!characters.length) {
                toastr.info('Open a chat and turn TTS on first, so there is a character to design for.', 'Fish Audio TTS');
                return;
            }
            openVoiceDesigner({
                api: pluginApi,
                characters,
                defaultCharacter: SillyTavern.getContext().name2,
                onSaved: (voice, character) => {
                    // A new voice has no free sample, and the own-voices list should pick it up.
                    this.ownVoicesAt = 0;
                    return this.useVoiceFor(voice, character);
                },
            });
        });
    }
}
