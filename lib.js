// Pure helpers for the Fish Audio TTS extension.
// No SillyTavern imports here so the functions can be unit-tested under Node.

// Distinct from "Fish Audio" so this never clashes with a core provider of that name.
export const PROVIDER_NAME = 'Fish Audio (Extension)';
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
    'drama-3': 'Drama 3 (paid, about $10 per 1M bytes, most expressive)',
});

/** Models that take several voices in one request (`<|speaker:N|>` markers plus a `reference_id` list). */
export const MULTI_SPEAKER_MODELS = Object.freeze(['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3']);
/** Models measured generating slower than real time. Streamed, their audio stalls mid-sentence. */
export const SLOW_MODELS = Object.freeze(['drama-3']);
/** USD per 1M UTF-8 bytes. Drama 3 isn't on Fish's pricing page, $10 was measured on 2026-10-16. */
export const MODEL_PRICES = Object.freeze({ 's2.1-pro-free': 0, 's2.1-pro': 15, 's2-pro': 15, 's1': 15, 'drama-3': 10 });
/** Speaker voice meaning "don't read this speaker's lines". */
export const MUTED = '__muted__';

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
    cues: true,
    cue_prompt: false,
    skip_markup: true,
    skip_tags: 'infobox, status, stats',
    read_narration: true,
    smooth_slow: true,
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
 * @param {(name: string) => string|null} resolveVoice Speaker name to voice id, or MUTED to drop the turn
 * @param {string} defaultVoiceId The voice SillyTavern picked for this message
 * @returns {{voices: string[], text: string, turns: {voiceId: string, speaker: string|null, text: string}[]}}
 */
export function buildSpeakerRequest(segments, resolveVoice, defaultVoiceId) {
    /** @type {{voiceId: string, speaker: string|null, text: string}[]} */
    const turns = [];
    for (const segment of segments) {
        const resolved = segment.speaker ? resolveVoice(segment.speaker) : null;
        if (resolved === MUTED) continue;
        const voiceId = resolved || defaultVoiceId;
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

// Emotion and delivery cues.
//
// S2 models and Drama 3 read [bracket] cues, free-form. S1 reads a fixed set
// of (parenthesis) tags and speaks anything else aloud. Cues are written in
// brackets and rewritten here for the selected model.

/** Fish's documented tag set, shared by S1 (in parentheses) and S2 (in brackets). */
export const CUE_TAGS = Object.freeze([
    'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised', 'satisfied', 'delighted',
    'scared', 'worried', 'upset', 'frustrated', 'depressed', 'empathetic', 'embarrassed', 'disgusted', 'moved',
    'proud', 'relaxed', 'grateful', 'curious', 'sarcastic',
    'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent', 'uncertain', 'doubtful', 'confused',
    'disappointed', 'regretful', 'guilty', 'ashamed', 'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic',
    'nostalgic', 'lonely', 'bored', 'contemptuous', 'sympathetic', 'compassionate', 'determined', 'resigned',
    'in a hurry tone', 'shouting', 'screaming', 'whispering', 'soft tone', 'emphasis',
    'laughing', 'chuckling', 'sobbing', 'crying loudly', 'sighing', 'groaning', 'panting', 'gasping', 'yawning',
    'snoring', 'clear throat',
    'audience laughing', 'background laughter', 'crowd laughing', 'break', 'long-break',
]);
const CUE_SET = new Set(CUE_TAGS);

// A cue-like bracket: starts and ends with a letter, words, spaces, commas,
// apostrophes and hyphens only. "[OOC: ...]", "[1]" and markdown links "[text](url)" don't match.
const CUE_SOURCE = "\\[([A-Za-z][A-Za-z ,'\u2019-]{0,58}[A-Za-z])\\](?!\\()";
const CUE_BRACKET_RE = new RegExp(CUE_SOURCE, 'g');
const CUE_PAREN_RE = /\(([A-Za-z][A-Za-z -]{0,30}[A-Za-z])\)/g;

/** Drama 3's word-level delivery tags. */
export const DRAMA_TAGS = Object.freeze(['whisper', 'emphasis', 'soft', 'fast', 'slow', 'stress', 'forceful']);
const PAIRED_TAG_RE = new RegExp(`<(${DRAMA_TAGS.join('|')})>([\\s\\S]*?)<\\/\\1>`, 'gi');
const LONE_DRAMA_TAG_RE = new RegExp(`<\\/?(?:${DRAMA_TAGS.join('|')})>`, 'gi');
/** Nearest S1/S2 cue for a Drama 3 tag. Tags without one keep just their words. */
const PAIRED_TAG_CUES = { whisper: 'whispering', soft: 'soft tone', emphasis: 'emphasis' };

/** Regex source for hiding cues in the chat display. Same shape as the cues rewritten for TTS. */
export const CUE_DISPLAY_REGEX = `/ ?${CUE_SOURCE}/g`;

/**
 * Rewrites cues for the model that will speak them. With cues off, every
 * cue-like bracket and every known (tag) is removed so nothing is read aloud.
 * @param {string} text
 * @param {string} model
 * @param {boolean} enabled
 */
export function rewriteCues(text, model, enabled) {
    const known = (cue) => CUE_SET.has(cue.trim().toLowerCase());
    let out = String(text);
    // Drama 3's word-level tags. Other models get the nearest cue, or plain words.
    if (!enabled || model !== 'drama-3') {
        out = out.replace(PAIRED_TAG_RE, (whole, tag, inner) => {
            const cue = enabled ? PAIRED_TAG_CUES[tag.toLowerCase()] : null;
            if (!cue) return inner;
            return model === 's1' ? `(${cue}) ${inner}` : `[${cue}] ${inner}`;
        }).replace(LONE_DRAMA_TAG_RE, '');
    }
    if (!enabled) {
        out = out.replace(CUE_BRACKET_RE, '').replace(CUE_PAREN_RE, (whole, cue) => (known(cue) ? '' : whole));
    } else if (model === 's1') {
        // S1 speaks unknown cues aloud, so only tags from its fixed set survive, in parentheses.
        out = out.replace(CUE_BRACKET_RE, (whole, cue) => (known(cue) ? `(${cue.trim().toLowerCase()})` : ''));
    } else {
        // S2 and Drama 3: brackets as written, legacy (tag) cues converted.
        out = out.replace(CUE_PAREN_RE, (whole, cue) => (known(cue) ? `[${cue.trim().toLowerCase()}]` : whole));
    }
    return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
}

/**
 * Instruction for the chat model, injected into the prompt when the user turns it on.
 * @param {string} model
 */
export function cueInstruction(model) {
    if (model === 'drama-3') {
        return [
            'Voice cues: this story is read aloud by a text-to-speech voice actor.',
            'Before a line of dialogue you may add a short direction in square brackets, written like a note to the actor:',
            '[slow, dangerously quiet], [voice breaking], [laughing nervously].',
            'Sounds and pauses go where they happen: [sighs], [short pause].',
            'To change only some words, wrap them in <whisper>, <emphasis>, <soft>, <fast>, <slow>, <stress> or <forceful>,',
            'like <whisper>don\'t move</whisper>.',
            'Use them sparingly: at most one direction per line of dialogue, only where the delivery clearly changes, never in narration.',
            'Do not escalate: irritation is not shouting, sadness is not sobbing, sarcasm is not laughter.',
        ].join(' ');
    }
    const examples = '[whispering], [laughing], [sighing], [angry], [soft tone], [break]';
    const vocabulary = model === 's1'
        ? `Use only these cues: ${CUE_TAGS.map(t => `[${t}]`).join(' ')}.`
        : `Cues can be short free-form descriptions like [tense, quiet voice], or simple tags like ${examples}.`;
    return [
        'Voice cues: this story is read aloud by a text-to-speech voice.',
        'Inside spoken dialogue you may put a short delivery cue in square brackets right before the words it shapes.',
        vocabulary,
        'Use them sparingly: at most one cue per line of dialogue, only where the delivery clearly changes, never in narration.',
        'Do not escalate: irritation is not shouting, sadness is not sobbing, sarcasm is not laughter.',
    ].join(' ');
}

// What gets read.
//
// Runs before speaker detection and cue rewriting. Reasoning blocks are always
// dropped. Infoboxes and markup are dropped by default: code blocks, HTML
// comments, markdown tables, HTML block elements and any tags the user lists.
// Remaining inline tags are stripped to their words, except Drama 3's.

const REASONING_RE = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
const FENCE_RE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const TABLE_ROW_RE = /^[ \t]*\|.*\|[ \t]*$\n?/gm;
const BLOCK_TAGS = Object.freeze(['div', 'details', 'table', 'section', 'aside', 'pre', 'style', 'script', 'figure',
    'iframe', 'svg', 'form', 'select', 'nav', 'header', 'footer']);
const INLINE_TAG_RE = new RegExp(`<\/?(?!(?:${DRAMA_TAGS.join('|')})\\b)[a-zA-Z][^>]*>`, 'g');
const MD_LINK_RE = /\[([^\]\n]+)\]\([^)\n]*\)/g;

/** @param {string} s */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tag names from a comma or space separated list. Drama 3's tags are never skipped.
 * @param {string} list
 */
export function parseTagList(list) {
    return [...new Set(String(list ?? '').split(/[\s,]+/)
        .map(t => t.replace(/[<>/]/g, '').trim().toLowerCase())
        .filter(t => /^[a-z][a-z0-9_-]{0,30}$/.test(t) && !DRAMA_TAGS.includes(t)))];
}

/**
 * Removes whole elements, nested ones included: `<div>…<div>…</div>…</div>`.
 * An element left open runs to the end of the text, as an infobox cut off by the reply limit would.
 * @param {string} text
 * @param {string[]} names
 */
export function removeTagBlocks(text, names) {
    if (!names.length) return text;
    const re = new RegExp(`<(\/?)(${names.map(escapeRegex).join('|')})\\b[^>]*?(\/?)>`, 'gi');
    let out = '';
    let last = 0;
    let depth = 0;
    let current = '';
    for (const match of text.matchAll(re)) {
        const [whole, closing, name, selfClosing] = match;
        const tag = name.toLowerCase();
        if (depth === 0) {
            if (closing) continue;
            out += text.slice(last, match.index);
            last = match.index + whole.length;
            if (!selfClosing) {
                depth = 1;
                current = tag;
            }
        } else if (tag === current && !selfClosing) {
            depth += closing ? -1 : 1;
            if (depth === 0) last = match.index + whole.length;
        }
    }
    return depth > 0 ? out : out + text.slice(last);
}

/**
 * @param {string} text
 * @param {{skipMarkup?: boolean, extraTags?: string[]}} [options]
 */
export function removeUnspoken(text, { skipMarkup = true, extraTags = [] } = {}) {
    let out = String(text).replace(REASONING_RE, '');
    if (skipMarkup) {
        out = out.replace(FENCE_RE, '\n').replace(COMMENT_RE, ' ');
        out = removeTagBlocks(out, [...BLOCK_TAGS, ...extraTags]);
        out = out.replace(TABLE_ROW_RE, '');
    } else if (extraTags.length) {
        out = removeTagBlocks(out, extraTags);
    }
    return out.replace(INLINE_TAG_RE, '').replace(MD_LINK_RE, '$1').replace(/\n{3,}/g, '\n\n').trim();
}

// Dialogue only. Quoted text is dialogue anywhere. A speaker line without
// quotes ("Alice: Hi there") is dialogue too, script style. Everything else is narration.
const QUOTE_RE = /"[^"\n]+"|“[^”\n]+”|«[^»\n]+»|「[^」\n]+」|『[^』\n]+』/g;
const LEADING_MARK_RE = new RegExp(`^(\\s*)(${MARK_OPEN}([^${MARK_CLOSE}]{1,40})${MARK_CLOSE} ?)?([\\s\\S]*)$`);

/**
 * Keeps only dialogue. Speaker markers stay, so voices still switch.
 * @param {string} text Text after markSpeakerLines (or plain text)
 */
export function keepDialogue(text) {
    return String(text).split('\n').map((line) => {
        const [, , marker = '', name, rest] = LEADING_MARK_RE.exec(line) ?? [];
        const quotes = (rest ?? '').match(QUOTE_RE);
        if (quotes) return `${marker}${quotes.join(' ')}`;
        if (name && name !== DEFAULT_SPEAKER && rest.trim()) return `${marker}${rest}`;
        return '';
    }).filter(line => line.trim()).join('\n');
}

// Smooth playback for slow models: whole sentences, generated ahead in
// parallel, each played once complete. All chunks start generating together,
// so chunk N is ready after about len(N)/speed while it is needed only after
// chunks 1..N-1 have played. Growing each chunk by at most ~1.6x the previous
// one keeps it ready in time at Drama 3's measured 0.6-1x real-time speed. The
// first chunk is one short sentence so audio starts soon.
const SENTENCE_RE = /[^.!?…。！？]+(?:[.!?…。！？]+["”’»」』)\]*]*|$)\s*/g;
const CLAUSE_RE = /[^,;:、，]+(?:[,;:、，]+\s*|$)/g;
const DRAMA_OPEN_RE = new RegExp(`<(?:${DRAMA_TAGS.join('|')})>`, 'gi');
const DRAMA_CLOSE_RE = new RegExp(`<\\/(?:${DRAMA_TAGS.join('|')})>`, 'gi');

/** @param {string} s */
const tagsBalanced = (s) => (s.match(DRAMA_OPEN_RE)?.length ?? 0) === (s.match(DRAMA_CLOSE_RE)?.length ?? 0);

/**
 * @param {string} text
 * @param {{first?: number, growth?: number, max?: number}} [options]
 * @returns {string[]}
 */
export function splitIntoChunks(text, { first = 30, growth = 1.6, max = 300 } = {}) {
    // Sentences, with very long ones broken at commas.
    const pieces = (String(text).match(SENTENCE_RE) ?? [])
        .flatMap(s => (s.length > max ? (s.match(CLAUSE_RE) ?? [s]) : [s]))
        .filter(s => s.trim());
    const chunks = [];
    let current = '';
    let limit = first;
    for (const piece of pieces) {
        const full = chunks.length === 0 ? current.length >= first : current.length + piece.length > limit;
        if (current && full && tagsBalanced(current)) {
            chunks.push(current.trim());
            limit = Math.min(max, Math.max(60, Math.round(current.trim().length * growth)));
            current = '';
        }
        current += piece;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

/**
 * Rough cost of reading some text on a model.
 * @param {string} text
 * @param {string} model
 * @returns {{bytes: number, usd: number|null}}
 */
export function estimateCost(text, model) {
    const bytes = new TextEncoder().encode(String(text)).length;
    const price = MODEL_PRICES[model];
    return { bytes, usd: price === undefined ? null : bytes * price / 1e6 };
}

// Voice design from a character card.

const CARD_FIELD_LIMIT = 2500;

/**
 * Prompt for the user's chat model to turn a character card into a short
 * voice casting brief for Fish's voice designer.
 * @param {{name: string, description?: string, personality?: string, scenario?: string}} card Macros already substituted
 * @returns {{systemPrompt: string, prompt: string}}
 */
export function buildBriefPrompt(card) {
    const field = (label, value) => {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, CARD_FIELD_LIMIT);
        return text ? `${label}: ${text}` : '';
    };
    const facts = [
        field('Name', card.name),
        field('Description', card.description),
        field('Personality', card.personality),
        field('Scenario', card.scenario),
    ].filter(Boolean).join('\n');
    return {
        systemPrompt: 'You write short voice casting briefs for a text-to-speech voice designer. Answer with the brief only.',
        prompt: `${facts}\n\nWrite one voice casting brief for this character: gender, apparent age, accent, pitch, tone, pace, `
            + 'and anything distinctive about how they sound. Two sentences at most, under 300 characters. '
            + 'Describe only the voice. No names, no quotes, no story details.',
    };
}

/**
 * Tidies a drafted brief: no quotes, markdown or line breaks, a sane length.
 * @param {string} text
 */
export function cleanBrief(text) {
    return String(text ?? '')
        .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
        .replace(/[*_#`"“”]/g, '')
        .replace(/^\s*(voice\s*)?(casting\s*)?brief\s*:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
}

const PREVIEW_DEFAULT = 'Hello. It is good to finally meet you.';

/**
 * A line for the candidates to read: the first quoted line of the character's
 * greeting if it fits Fish's 150-character limit, else a neutral line.
 * @param {string} firstMessage Macros already substituted
 */
export function pickPreviewLine(firstMessage) {
    const quotes = String(firstMessage ?? '').match(/"([^"\n]{12,150})"|“([^”\n]{12,150})”/g) ?? [];
    for (const quote of quotes) {
        const line = quote.slice(1, -1).replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
        if (line.length >= 12 && line.length <= 150) return line;
    }
    return PREVIEW_DEFAULT;
}
