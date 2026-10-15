// Small DOM helpers shared by the popups. Text from Fish or character cards
// is user-written, so nodes are built with textContent, never innerHTML.

/** @param {string} tag @param {Record<string, any>} [props] @param {...(Node|string)} children */
export function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

export const LANGUAGES = Object.freeze([
    ['en', 'English'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean'], ['es', 'Spanish'], ['fr', 'French'],
    ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ru', 'Russian'], ['ar', 'Arabic'], ['hi', 'Hindi'],
    ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['tr', 'Turkish'], ['pl', 'Polish'], ['nl', 'Dutch'],
]);

/** Name shown for SillyTavern's voice map entry that covers everyone without their own voice. */
export const DEFAULT_VOICE_MARKER = '[Default Voice]';

/** @param {string} name Voice map entry name */
export function characterLabel(name) {
    return name === DEFAULT_VOICE_MARKER ? 'Everyone else (default voice)' : name;
}
