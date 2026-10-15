import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildTtsBody,
    buildVoiceObjects,
    compareVersions,
    DEFAULT_SETTINGS,
    formatBytes,
    formatCredit,
    mergeSettings,
    parseVoiceInput,
    sanitizeLabel,
    stableSample,
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
