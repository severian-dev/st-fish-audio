// Pure helpers for the Fish Audio TTS extension.
// No SillyTavern imports here so the functions can be unit-tested under Node.

export const PLUGIN_BASE = '/api/plugins/fish-audio';
export const SILENCE_URL = '/sounds/silence.mp3';
export const SECRET_KEY = 'api_key_fish_audio';
export const MIN_PLUGIN_VERSION = '0.1.0';

/** Shown next to each model in the dropdown. Unknown ids from a newer plugin fall back to the raw id. */
export const MODEL_LABELS = Object.freeze({
    's2.1-pro-free': 'S2.1 Pro Free (free until Nov 30, 2026)',
    's2.1-pro': 'S2.1 Pro (paid, $15 per 1M bytes)',
    's2-pro': 'S2 Pro (paid, $15 per 1M bytes)',
    's1': 'S1 (paid, deprecated, retires Dec 31, 2026)',
    'drama-3': 'Drama 3 (paid)',
});

/** Models that take several voices in one request (`<|speaker:N|>` markers plus a `reference_id` list). */
export const MULTI_SPEAKER_MODELS = Object.freeze(['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3']);

export const DEFAULT_SETTINGS = Object.freeze({
    voiceMap: {},
    model: 's2.1-pro-free',
    latency: 'balanced',
    speed: 1,
    temperature: 0.7,
    top_p: 0.7,
    normalize_loudness: true,
    cache_audio: true,
    multi_speaker: true,
    /** @type {SavedVoice[]} */
    savedVoices: [],
    /** @type {Speaker[]} */
    speakers: [],
});

/**
 * @typedef {object} Speaker
 * @property {string} name Name as it appears before the colon
 * @property {string} voice Label of a saved voice
 */

/**
 * @typedef {object} SavedVoice
 * @property {string} id Fish voice model id
 * @property {string} label Unique name shown in SillyTavern's voice map
 * @property {string} title Fish's title for the voice
 * @property {string[]} languages
 * @property {string|null} sample Free sample clip URL
 * @property {string|null} cover Cover image URL
 */

const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_ID_RE = /\b([0-9a-f]{32})\b/i;

/** @param {unknown} id */
export function isVoiceId(id) {
    return typeof id === 'string' && VOICE_ID_RE.test(id);
}

/**
 * Pulls a voice id out of what a user pastes: a bare id or a fish.audio link.
 * @param {string} input
 * @returns {string|null}
 */
export function parseVoiceInput(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    if (/^[0-9a-f]{32}$/i.test(text)) return text.toLowerCase();
    if (/^https?:\/\//i.test(text)) {
        let url;
        try {
            url = new URL(text);
        } catch {
            return null;
        }
        if (!/(^|\.)fish\.audio$/i.test(url.hostname)) return null;
        const match = HEX_ID_RE.exec(url.pathname);
        return match ? match[1].toLowerCase() : null;
    }
    return null;
}

/**
 * SillyTavern shows voice names as raw HTML in its "Available voices" popup,
 * and Fish titles are user-written. Labels are reduced to plain text that is
 * safe there and readable in the voice map.
 * @param {string} title
 */
export function sanitizeLabel(title) {
    const clean = String(title ?? '')
        .replace(/[<>&"'`\\]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || 'Untitled voice';
}

/**
 * Picks a label that no other voice uses. Fish titles repeat ("Verity" has
 * several), and SillyTavern's voice map stores the label, so it must be unique.
 * @param {string} title
 * @param {string} id
 * @param {Iterable<string>} taken Labels already in use
 */
export function uniqueLabel(title, id, taken) {
    const used = new Set(taken);
    const base = sanitizeLabel(title);
    if (!used.has(base)) return base;
    const withId = `${base} (${String(id).slice(0, 6)})`;
    if (!used.has(withId)) return withId;
    return `${base} (${id})`;
}

/**
 * Merges stored settings over the defaults. Unknown keys are dropped and
 * mistyped ones fall back, so a hand-edited or older settings file never breaks loading.
 * @param {Record<string, any>} stored
 */
export function mergeSettings(stored) {
    const out = structuredClone(DEFAULT_SETTINGS);
    if (!stored || typeof stored !== 'object') return out;
    for (const key of Object.keys(out)) {
        if (!(key in stored)) continue;
        const value = stored[key];
        if (key === 'savedVoices') {
            out.savedVoices = Array.isArray(value)
                ? value.filter(v => v && isVoiceId(v.id) && typeof v.label === 'string')
                    .map(v => ({ ...v, languages: Array.isArray(v.languages) ? v.languages : [], sample: stableSample(v.sample) }))
                : [];
        } else if (key === 'speakers') {
            out.speakers = Array.isArray(value)
                ? value.filter(v => v && typeof v.name === 'string' && typeof v.voice === 'string')
                    .map(v => ({ name: v.name, voice: v.voice }))
                : [];
        } else if (key === 'voiceMap') {
            out.voiceMap = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } else if (typeof value === typeof out[key]) {
            out[key] = value;
        }
    }
    return out;
}

/**
 * Fish search results link samples on its public CDN, but a single-voice
 * lookup returns a signed link that expires within the hour. Only links that
 * stay valid are worth storing.
 * @param {unknown} url
 * @returns {string|null}
 */
export function stableSample(url) {
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        if (!/(^|\.)r2\.fish\.audio$/.test(parsed.hostname)) return null;
        if ([...parsed.searchParams.keys()].some(k => /^x-amz-/i.test(k))) return null;
        return url;
    } catch {
        return null;
    }
}

/**
 * Turns a voice from the plugin into a saved voice with a unique label.
 * @param {{id: string, title: string, languages?: string[], sample?: string|null, cover?: string|null}} voice
 * @param {SavedVoice[]} saved
 * @returns {SavedVoice}
 */
export function toSavedVoice(voice, saved) {
    return {
        id: voice.id,
        label: uniqueLabel(voice.title, voice.id, saved.map(v => v.label)),
        title: String(voice.title ?? ''),
        languages: Array.isArray(voice.languages) ? voice.languages.map(String) : [],
        sample: stableSample(voice.sample),
        cover: typeof voice.cover === 'string' ? voice.cover : null,
    };
}

/**
 * Builds SillyTavern voice objects: saved voices first, then the user's own
 * Fish voices that aren't saved yet.
 * @param {SavedVoice[]} saved
 * @param {Array<{id: string, title: string, languages?: string[], sample?: string|null}>} own
 * @returns {{name: string, voice_id: string, lang: string, preview_url: string|false}[]}
 */
export function buildVoiceObjects(saved, own) {
    const out = saved.map(v => ({
        name: v.label,
        voice_id: v.id,
        lang: v.languages[0] ?? '',
        preview_url: stableSample(v.sample) || false,
    }));
    const ids = new Set(saved.map(v => v.id));
    const labels = out.map(v => v.name);
    for (const voice of own) {
        if (!isVoiceId(voice.id) || ids.has(voice.id)) continue;
        const name = uniqueLabel(`${voice.title} (mine)`, voice.id, labels);
        labels.push(name);
        ids.add(voice.id);
        out.push({ name, voice_id: voice.id, lang: voice.languages?.[0] ?? '', preview_url: stableSample(voice.sample) || false });
    }
    return out;
}

/**
 * The plugin request body for one TTS call.
 * @param {string} text
 * @param {string|string[]} voiceId
 * @param {typeof DEFAULT_SETTINGS} settings
 */
export function buildTtsBody(text, voiceId, settings) {
    return {
        text,
        reference_id: voiceId,
        model: settings.model,
        latency: settings.latency,
        temperature: settings.temperature,
        top_p: settings.top_p,
        prosody: { speed: settings.speed, normalize_loudness: settings.normalize_loudness },
        cache: settings.cache_audio,
    };
}

/**
 * @param {string} a Semver-ish version
 * @param {string} b
 * @returns {number} Negative if a < b
 */
export function compareVersions(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes) || 0)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @param {string|number|null} credit Fish's credit value (a decimal string)
 */
export function formatCredit(credit) {
    if (credit === null || credit === undefined || credit === '') return 'unknown';
    const n = Number(credit);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : 'unknown';
}

// Several voices per message.
//
// SillyTavern collapses line breaks before it calls generateTts, so speaker
// lines are found earlier, in processText, and replaced with a marker that
// survives the collapse. generateTts then turns the markers into Fish's
// `<|speaker:N|>` format with one voice per speaker.

const MARK_OPEN = '\u27EA';
const MARK_CLOSE = '\u27EB';
const MARK_RE = new RegExp(`${MARK_OPEN}([^${MARK_CLOSE}]{1,40})${MARK_CLOSE}`, 'g');
// "Alice: text", "**Alice**: text", "Old Tom: text". Up to 4 words, 40 characters.
const SPEAKER_LINE_RE = /^([ \t]*)(?:\*\*|__)?([\p{L}\p{N}][\p{L}\p{N}.'\u2019-]*(?: [\p{L}\p{N}][\p{L}\p{N}.'\u2019-]*){0,3})(?:\*\*|__)?[ \t]*:(?!\/\/)[ \t]*(?=\S)/u;
/** Marker name meaning "back to the message's own voice". Can't clash: names start with a letter or digit. */
const DEFAULT_SPEAKER = '*';

/** @param {string} name */
export function speakerMark(name) {
    return `${MARK_OPEN}${name}${MARK_CLOSE}`;
}

/**
 * Replaces `Name:` at the start of a line with a speaker marker, but only for
 * names that resolve to a voice. "Note:" or "Time:" lines stay untouched.
 * Each line stands alone: once a speaker line has appeared, an unlabelled
 * line goes back to the message's own voice, as narration does in a script.
 * @param {string} text
 * @param {(name: string) => boolean} isKnown
 */
export function markSpeakerLines(text, isKnown) {
    let marked = false;
    return String(text).split('\n').map((line) => {
        const match = SPEAKER_LINE_RE.exec(line);
        if (match && match[2].length <= 40 && isKnown(match[2])) {
            marked = true;
            return `${match[1]}${speakerMark(match[2])} ${line.slice(match[0].length)}`;
        }
        if (marked && line.trim()) return `${speakerMark(DEFAULT_SPEAKER)} ${line}`;
        return line;
    }).join('\n');
}

/** @param {string} text */
export function stripSpeakerMarks(text) {
    return String(text).replace(MARK_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} text */
export function hasSpeakerMarks(text) {
    return new RegExp(MARK_RE.source).test(String(text));
}

/**
 * Splits marked text into speaker turns. Text before the first marker has no speaker.
 * @param {string} text
 * @returns {{speaker: string|null, text: string}[]}
 */
export function splitSpeakerSegments(text) {
    const out = [];
    let speaker = null;
    let last = 0;
    for (const match of String(text).matchAll(MARK_RE)) {
        out.push({ speaker, text: text.slice(last, match.index) });
        speaker = match[1] === DEFAULT_SPEAKER ? null : match[1];
        last = match.index + match[0].length;
    }
    out.push({ speaker, text: text.slice(last) });
    return out
        .map(s => ({ speaker: s.speaker, text: s.text.replace(/\s+/g, ' ').trim() }))
        .filter(s => s.text);
}

/**
 * Builds a Fish request from speaker turns. Turns without a known voice use
 * the message's own voice. Neighbouring turns with the same voice merge.
 * @param {{speaker: string|null, text: string}[]} segments
 * @param {(name: string) => string|null} resolveVoice Speaker name to voice id
 * @param {string} defaultVoiceId The voice SillyTavern picked for this message
 * @returns {{voices: string[], text: string, turns: {voiceId: string, speaker: string|null, text: string}[]}}
 */
export function buildSpeakerRequest(segments, resolveVoice, defaultVoiceId) {
    /** @type {{voiceId: string, speaker: string|null, text: string}[]} */
    const turns = [];
    for (const segment of segments) {
        const voiceId = (segment.speaker && resolveVoice(segment.speaker)) || defaultVoiceId;
        const prev = turns.at(-1);
        if (prev && prev.voiceId === voiceId) {
            prev.text = `${prev.text} ${segment.text}`;
        } else {
            turns.push({ voiceId, speaker: segment.speaker, text: segment.text });
        }
    }
    const voices = [...new Set(turns.map(t => t.voiceId))];
    const text = voices.length <= 1
        ? turns.map(t => t.text).join(' ')
        : turns.map(t => `<|speaker:${voices.indexOf(t.voiceId)}|>${t.text}`).join('');
    return { voices, text, turns };
}
