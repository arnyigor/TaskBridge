// Text survives reloads; browser File objects belong only to the current page.
export class ComposerDraftStore {
  constructor({ storage = () => globalThis.localStorage } = {}) {
    this.storage = storage;
    this.memory = new Map();
  }

  get(key) {
    if (!this.memory.has(key)) {
      try {
        const saved = JSON.parse(this.storage().getItem(`tbDraft:${key}`) || 'null');
        if (typeof saved?.text === 'string' && saved.text) {
          this.memory.set(key, { text: saved.text, files: [] });
        }
      } catch { /* unavailable storage or unreadable entry: empty composer */ }
    }
    return this.memory.get(key);
  }

  set(key, { text, files }) {
    if (!text && !files.length) { this.delete(key); return; }
    this.memory.set(key, { text, files });
    try { this.storage().setItem(`tbDraft:${key}`, JSON.stringify({ text })); }
    catch { /* memory still retains the draft when storage is full/private */ }
  }

  delete(key) {
    this.memory.delete(key);
    try { this.storage().removeItem(`tbDraft:${key}`); }
    catch { /* unavailable storage */ }
  }
}
