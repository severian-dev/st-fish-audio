import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildSpeakerRequest,
    buildTtsBody,
    buildVoiceObjects,
    compareVersions,
    CUE_DISPLAY_REGEX,
    cueInstruction,
    DEFAULT_SETTINGS,
    estimateCost,
    formatBytes,
    formatCredit,
    hasSpeakerMarks,
    keepDialogue,
    markSpeakerLines,
    mergeSettings,
    MUTED,
    parseTagList,
    parseVoiceInput,
    removeTagBlocks,
    removeUnspoken,
    rewriteCues,
    sanitizeLabel,
    splitIntoChunks,
    splitSpeakerSegments,
    stableSample,
    stripSpeakerMarks,
    toSavedVoice,
    uniqueLabel,
} from '../lib.js';

const ID = 'f3a2b90078d54a65af4b95f63bc7798e';
const ID2 = 'd13f84b987ad4f22b56d2b47f4eb838e';

describe('parseVoiceInput', () => {
    it('accepts bare ids and fish.audio links', () => {
        assert.equal(parseVoiceInput(` ${ID.toUpperCase()} `), ID);
        assert.equal(parseVoiceInput(`https://fish.audio/m/${ID}/`), ID);
        assert.equal(parseVoiceInput(`https://fish.audio/app/m/${ID}?share=1`), ID);
        assert.equal(parseVoiceInput(`https://www.fish.audio/m/${ID}`), ID);
    });

    it('rejects other hosts and junk', () => {
        assert.equal(parseVoiceInput(`https://evil.example/m/${ID}`), null);
        assert.equal(parseVoiceInput(`https://fish.audio.evil.example/m/${ID}`), null);
        assert.equal(parseVoiceInput('https://fish.audio/discovery'), null);
        assert.equal(parseVoiceInput('hello'), null);
        assert.equal(parseVoiceInput(''), null);
        assert.equal(parseVoiceInput('not a url://'), null);
    });
});

describe('labels', () => {
    it('strips markup characters and control codes', () => {
        assert.equal(sanitizeLabel('<img src=x onerror=alert(1)>Sheila'), 'img src=x onerror=alert(1)Sheila');
        assert.equal(sanitizeLabel(' A\n\tB "C" '), 'A B C');
        assert.equal(sanitizeLabel(''), 'Untitled voice');
        assert.equal(sanitizeLabel('x'.repeat(200)).length, 80);
    });

    it('makes repeated titles unique with the id', () => {
        assert.equal(uniqueLabel('Verity', ID, []), 'Verity');
        assert.equal(uniqueLabel('Verity', ID, ['Verity']), 'Verity (f3a2b9)');
        assert.equal(uniqueLabel('Verity', ID, ['Verity', 'Verity (f3a2b9)']), `Verity (${ID})`);
    });
});

describe('mergeSettings', () => {
    it('fills defaults and drops unknown or mistyped keys', () => {
        const s = mergeSettings({ model: 's2.1-pro', speed: 'fast', evil: true, voiceMap: { Alice: 'Sheila' } });
        assert.equal(s.model, 's2.1-pro');
        assert.equal(s.speed, DEFAULT_SETTINGS.speed);
        assert.equal('evil' in s, false);
        assert.deepEqual(s.voiceMap, { Alice: 'Sheila' });
    });

    it('filters broken saved voices and never shares the default arrays', () => {
        const s = mergeSettings({ savedVoices: [{ id: ID, label: 'Sheila' }, { id: '../x', label: 'bad' }, null, { id: ID2 }] });
        assert.deepEqual(s.savedVoices.map(v => v.id), [ID]);
        const a = mergeSettings({});
        a.savedVoices.push({ id: ID, label: 'x' });
        assert.equal(mergeSettings({}).savedVoices.length, 0);
    });

    it('survives garbage', () => {
        assert.deepEqual(mergeSettings(null), mergeSettings({}));
        assert.deepEqual(mergeSettings({ voiceMap: [], savedVoices: 'x' }).savedVoices, []);
    });
});

describe('voice objects', () => {
    it('lists saved voices first, then own voices not already saved, all with unique names', () => {
        const saved = [toSavedVoice({ id: ID, title: 'Sheila', languages: ['en'], sample: 'https://platform.r2.fish.audio/task/1.mp3' }, [])];
        const own = [
            { id: ID, title: 'Sheila', languages: ['en'] },
            { id: ID2, title: 'Me', languages: ['ja'], sample: null },
            { id: 'bad id', title: 'x' },
        ];
        const voices = buildVoiceObjects(saved, own);
        assert.deepEqual(voices, [
            { name: 'Sheila', voice_id: ID, lang: 'en', preview_url: 'https://platform.r2.fish.audio/task/1.mp3' },
            { name: 'Me (mine)', voice_id: ID2, lang: 'ja', preview_url: false },
        ]);
    });
});

describe('buildTtsBody', () => {
    it('maps settings onto the plugin request', () => {
        const body = buildTtsBody('Hello', ID, { ...DEFAULT_SETTINGS, speed: 1.2 });
        assert.deepEqual(body, {
            text: 'Hello', reference_id: ID, model: 's2.1-pro-free', latency: 'balanced',
            temperature: 0.7, top_p: 0.7, prosody: { speed: 1.2, normalize_loudness: true }, cache: true,
        });
    });
});

describe('misc', () => {
    it('compares versions', () => {
        assert.ok(compareVersions('0.1.0', '0.1.0') === 0);
        assert.ok(compareVersions('0.0.9', '0.1.0') < 0);
        assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
        assert.ok(compareVersions('1.0', '1.0.1') < 0);
    });

    it('formats bytes', () => {
        assert.equal(formatBytes(0), '0 B');
        assert.equal(formatBytes(2048), '2 KB');
        assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    });

    it('formats credit', () => {
        assert.equal(formatCredit('0.000000'), '$0.00');
        assert.equal(formatCredit('12.3456'), '$12.35');
        assert.equal(formatCredit(null), 'unknown');
        assert.equal(formatCredit('abc'), 'unknown');
    });
});

describe('stableSample', () => {
    it('keeps public CDN links and drops signed or foreign ones', () => {
        assert.equal(stableSample('https://platform.r2.fish.audio/task/1.mp3'), 'https://platform.r2.fish.audio/task/1.mp3');
        assert.equal(stableSample('https://x.r2.cloudflarestorage.com/t.mp3?X-Amz-Expires=3600'), null);
        assert.equal(stableSample('https://platform.r2.fish.audio/t.mp3?X-Amz-Signature=abc'), null);
        assert.equal(stableSample('http://platform.r2.fish.audio/t.mp3'), null);
        assert.equal(stableSample('https://r2.fish.audio.evil.example/t.mp3'), null);
        assert.equal(stableSample(null), null);
    });

    it('is applied when saving and listing voices', () => {
        const signed = 'https://x.r2.cloudflarestorage.com/t.mp3?X-Amz-Expires=3600';
        assert.equal(toSavedVoice({ id: ID, title: 'S', sample: signed }, []).sample, null);
        const voices = buildVoiceObjects([], [{ id: ID2, title: 'Me', sample: signed }]);
        assert.equal(voices[0].preview_url, false);
    });
});

describe('several voices per message', () => {
    const known = (n) => ['Alice', 'Old Tom', 'Zoë'].includes(n);

    it('marks known speaker lines only', () => {
        const text = 'The door opens.\nAlice: "Hi."\nNote: not a speaker\n**Old Tom**: Grr.\n  Zoë:Bonjour\nTime: 3pm';
        const segs = splitSpeakerSegments(markSpeakerLines(text, known).replace(/\s+/g, ' '));
        assert.deepEqual(segs, [
            { speaker: null, text: 'The door opens.' },
            { speaker: 'Alice', text: '"Hi."' },
            { speaker: null, text: 'Note: not a speaker' },
            { speaker: 'Old Tom', text: 'Grr.' },
            { speaker: 'Zoë', text: 'Bonjour' },
            { speaker: null, text: 'Time: 3pm' },
        ]);
    });

    it('leaves text without speaker lines alone', () => {
        const text = 'Just prose.\nMore prose: with a colon.';
        assert.equal(markSpeakerLines(text, known), text);
        assert.equal(hasSpeakerMarks(text), false);
    });

    it('ignores colons later in a line, URLs and over-long names', () => {
        assert.equal(hasSpeakerMarks(markSpeakerLines('She said Alice: no.', known)), false);
        assert.equal(hasSpeakerMarks(markSpeakerLines('https://example.com', () => true)), false);
        assert.equal(hasSpeakerMarks(markSpeakerLines('Alice the very long-winded queen of: x', () => true)), false);
    });

    it('builds one multi-speaker request with voices in order of appearance', () => {
        const segs = splitSpeakerSegments(markSpeakerLines('Narration.\nAlice: Hi.\nOld Tom: Grr.\nAlice: Bye.', known).replace(/\s+/g, ' '));
        const voices = { Alice: 'A', 'Old Tom': 'T' };
        const req = buildSpeakerRequest(segs, n => voices[n] ?? null, 'D');
        assert.deepEqual(req.voices, ['D', 'A', 'T']);
        assert.equal(req.text, '<|speaker:0|>Narration.<|speaker:1|>Hi.<|speaker:2|>Grr.<|speaker:1|>Bye.');
    });

    it('merges neighbours with the same voice and drops markers when only one voice is left', () => {
        const segs = [{ speaker: null, text: 'One.' }, { speaker: 'Alice', text: 'Two.' }, { speaker: 'Ghost', text: 'Three.' }];
        const req = buildSpeakerRequest(segs, n => (n === 'Alice' ? 'D' : null), 'D');
        assert.deepEqual(req.voices, ['D']);
        assert.equal(req.text, 'One. Two. Three.');
    });

    it('marks survive whitespace collapse and strip cleanly', () => {
        const marked = markSpeakerLines('Alice: Hi.\nThen silence.', known);
        assert.equal(stripSpeakerMarks(marked.replace(/\s+/g, ' ')), 'Hi. Then silence.');
    });
});

describe('voice cues', () => {
    const text = 'Alice: [angry] "Get out!" (sighing)\n[OOC: test] see [the link](http://x) [1]\nShe [tense, quiet voice] spoke. (aside)';

    it('keeps brackets for S2 and converts known legacy tags', () => {
        assert.equal(rewriteCues(text, 's2.1-pro-free', true),
            'Alice: [angry] "Get out!" [sighing]\n[OOC: test] see [the link](http://x) [1]\nShe [tense, quiet voice] spoke. (aside)');
    });

    it('keeps only known tags for S1, in parentheses', () => {
        assert.equal(rewriteCues(text, 's1', true),
            'Alice: (angry) "Get out!" (sighing)\n[OOC: test] see [the link](http://x) [1]\nShe spoke. (aside)');
    });

    it('removes cues when turned off and leaves other brackets', () => {
        assert.equal(rewriteCues(text, 's2.1-pro', false),
            'Alice: "Get out!"\n[OOC: test] see [the link](http://x) [1]\nShe spoke. (aside)');
    });

    it('builds a model-aware instruction', () => {
        assert.match(cueInstruction('s2.1-pro-free'), /free-form/);
        assert.match(cueInstruction('s1'), /Use only these cues: \[happy\]/);
        assert.equal(cueInstruction('s1').includes('—'), false);
    });

    it('display regex hides the same cues', () => {
        const [, body, flags] = /^\/(.*)\/(\w*)$/.exec(CUE_DISPLAY_REGEX);
        const re = new RegExp(body, flags);
        assert.equal('She [whispering] spoke. [OOC: keep] [link](x)'.replace(re, ''), 'She spoke. [OOC: keep] [link](x)');
    });
});

describe('what gets read', () => {
    const msg = [
        '<think>plan the reply</think>',
        'The rain fell.',
        '<div class="box"><div>HP: 10</div>Mood: tense</div>',
        '| Stat | Val |',
        '|---|---|',
        '| HP | 10 |',
        '```',
        'status: ok',
        '```',
        '<infobox>Location: dock</infobox>',
        'Alice: <b>"Who</b> goes there?" she asked. See [the map](http://x).',
        '<!-- hidden -->She <whisper>held her breath</whisper>.',
    ].join('\n');

    it('drops reasoning, infoboxes and markup but keeps Drama 3 tags', () => {
        const out = removeUnspoken(msg, { extraTags: parseTagList('infobox, status') });
        assert.equal(out, 'The rain fell.\n\nAlice: "Who goes there?" she asked. See the map.\n She <whisper>held her breath</whisper>.');
    });

    it('still drops reasoning and listed tags with markup skipping off', () => {
        const out = removeUnspoken(msg, { skipMarkup: false, extraTags: ['infobox'] });
        assert.equal(out.includes('plan the reply'), false);
        assert.equal(out.includes('Location'), false);
        assert.equal(out.includes('HP: 10'), true);
    });

    it('handles nesting, self-closing tags and a block cut off at the end', () => {
        assert.equal(removeTagBlocks('a<div>b<div>c</div>d</div>e', ['div']), 'ae');
        assert.equal(removeTagBlocks('a<div/>b', ['div']), 'ab');
        assert.equal(removeTagBlocks('a<details>never closed', ['details']), 'a');
        assert.equal(removeTagBlocks('a</div>b', ['div']), 'a</div>b');
    });

    it('parses tag lists and never skips Drama 3 tags', () => {
        assert.deepEqual(parseTagList(' <Infobox>, status  stats, whisper, bad!tag, infobox'), ['infobox', 'status', 'stats']);
    });

    it('keeps only dialogue, with speaker markers', () => {
        const marked = markSpeakerLines('The rain fell.\nAlice: "Who goes there?" she asked.\nBob: Just me.\nShe nodded. "Fine," she said, "come in."\nNo dialogue here.', n => ['Alice', 'Bob'].includes(n));
        const segs = splitSpeakerSegments(keepDialogue(marked).replace(/\s+/g, ' '));
        assert.deepEqual(segs, [
            { speaker: 'Alice', text: '"Who goes there?"' },
            { speaker: 'Bob', text: 'Just me.' },
            { speaker: null, text: '"Fine," "come in."' },
        ]);
    });

    it('mutes speakers', () => {
        const segs = [{ speaker: null, text: 'Narration.' }, { speaker: 'Alice', text: 'Hi.' }, { speaker: 'Bob', text: 'Yo.' }];
        const req = buildSpeakerRequest(segs, n => (n === 'Bob' ? MUTED : n === 'Alice' ? 'A' : null), 'D');
        assert.deepEqual(req.turns.map(t => t.text), ['Narration.', 'Hi.']);
    });
});

describe('Drama 3', () => {
    it('keeps paired tags for Drama 3 and maps them for other models', () => {
        const text = 'She <whisper>held her breath</whisper>, <fast>then ran</fast>.';
        assert.equal(rewriteCues(text, 'drama-3', true), text);
        assert.equal(rewriteCues(text, 's2.1-pro', true), 'She [whispering] held her breath, then ran.');
        assert.equal(rewriteCues(text, 's1', true), 'She (whispering) held her breath, then ran.');
        assert.equal(rewriteCues(text, 'drama-3', false), 'She held her breath, then ran.');
    });

    it('has its own cue instruction', () => {
        assert.match(cueInstruction('drama-3'), /<whisper>don't move<\/whisper>/);
        assert.equal(cueInstruction('drama-3').includes('—'), false);
    });

    it('splits into sentence chunks: short first, growing, tags unbroken', () => {
        const text = 'The rain had not stopped for three days. Mara pulled her hood lower and counted the lanterns along the harbor wall. '
            + 'Seven, then six, then five as the wind took them. <whisper>Somewhere a door slammed. She did not turn.</whisper> The end.';
        const chunks = splitIntoChunks(text);
        assert.equal(chunks[0], 'The rain had not stopped for three days.');
        assert.equal(chunks.join(' '), text);
        for (let i = 1; i < chunks.length; i++) {
            const sentences = chunks[i].match(/[.!?]/g)?.length ?? 1;
            const tagged = chunks[i].includes('<whisper>'); // keeping a tag span whole wins over the growth limit
            assert.ok(chunks[i].length <= Math.max(60, chunks[i - 1].length * 1.6) || sentences === 1 || tagged, `chunk ${i} grew too fast`);
        }
        for (const c of chunks) assert.equal((c.match(/<whisper>/g) ?? []).length, (c.match(/<\/whisper>/g) ?? []).length);
    });

    it('breaks a very long sentence at commas', () => {
        const long = Array.from({ length: 30 }, (_, i) => `clause number ${i}`).join(', ') + '.';
        const chunks = splitIntoChunks(long, { max: 120 });
        assert.ok(chunks.length > 2);
        assert.ok(chunks.every(c => c.length <= 140));
        assert.equal(chunks.join(' '), long);
    });

    it('estimates cost by UTF-8 bytes', () => {
        assert.deepEqual(estimateCost('x'.repeat(8000), 'drama-3'), { bytes: 8000, usd: 0.08 });
        assert.equal(estimateCost('日本語', 's2.1-pro').bytes, 9);
        assert.equal(estimateCost('hi', 's2.1-pro-free').usd, 0);
    });
});
