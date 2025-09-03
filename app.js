(() => {
  'use strict';

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const preview = $('preview');
  const titleInput = $('titleInput');
  const noteList = $('noteList');
  const searchInput = $('searchInput');
  const statusBadge = $('statusBadge');
  const newBtn = $('newNoteBtn');
  const saveBtn = $('saveNoteBtn');
  const deleteBtn = $('deleteNoteBtn');
  const exportBtn = $('exportBtn');
  const importInput = $('importInput');

  // Storage keys
  const LS_NOTES = 'mdnote.notes.v1';
  const LS_SELECTED = 'mdnote.selectedId.v1';

  // State
  /** @type {{id:string,title:string,content:string,updatedAt:number}[]} */
  let notes = [];
  /** @type {string|null} */
  let selectedId = null;
  let dirty = false;
  let autosaveTimer = null;

  // Utils
  const now = () => Date.now();
  const fmtTime = (ms) => new Date(ms).toLocaleString();
  const uid = () => 'n_' + Math.random().toString(36).slice(2, 8) + '_' + now().toString(36);
  const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const sanitizeUrl = (url) => {
    try {
       const u = new URL(url, location.origin);
       const allowed = ['http:', 'https:', 'mailto:', 'tel:'];
       if (!allowed.includes(u.protocol)) return '#';
       return u.href;
    } catch { return '#'; }
  };

  // Minimal Markdown renderer (safe, HTML-escaped)
  function renderMarkdown(src) {
    if (!src) return '';

    // Normalize line endings
    src = src.replace(/\r\n?/g, '\n');

    const lines = src.split('\n');
    let i = 0;
    let html = '';
    let inCode = false;
    let listType = null; // 'ul' | 'ol'
    let inBlockquote = false;

    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };
    const closeBlockquote = () => {
      if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
    };

    while (i < lines.length) {
      let line = lines[i];

      // Fenced code blocks ```
      if (!inCode && /^```/.test(line)) {
        closeList();
        closeBlockquote();
        inCode = true; i++;
        let code = '';
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code += lines[i] + '\n';
          i++;
        }
        // skip closing fence
        if (i < lines.length) i++;
        html += `<pre><code>${escapeHtml(code)}</code></pre>`;
        continue;
      }
      if (inCode) {
        // Should not reach here because we consume until closing fence
        i++; continue;
      }

      // Horizontal rule
      if (/^\s*(\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)\s*$/.test(line)) {
        closeList();
        closeBlockquote();
        html += '<hr />';
        i++; continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        closeList();
        if (!inBlockquote) { html += '<blockquote>'; inBlockquote = true; }
        const content = line.replace(/^\s*>\s?/, '');
        html += inlineToHtml(content);
        html += '<br />';
        i++; continue;
      } else {
        closeBlockquote();
      }

      // Headings # .. ######
      const h = line.match(/^(#{1,6})\s+(.+)/);
      if (h) {
        closeList();
        const level = h[1].length;
        const body = inlineToHtml(h[2].trim());
        html += `<h${level}>${body}</h${level}>`;
        i++; continue;
      }

      // Lists
      const mUl = line.match(/^\s*([*+-])\s+(.+)/);
      const mOl = line.match(/^\s*(\d+)\.\s+(.+)/);
      if (mUl || mOl) {
        const type = mUl ? 'ul' : 'ol';
        if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
        const item = inlineToHtml((mUl ? mUl[2] : mOl[2]).trim());
        html += `<li>${item}</li>`;
        i++;
        continue;
      } else {
        closeList();
      }

      // Empty line -> paragraph break
      if (/^\s*$/.test(line)) { html += ''; i++; continue; }

      // Paragraph
      html += `<p>${inlineToHtml(line.trim())}</p>`;
      i++;
    }

    closeList();
    closeBlockquote();
    return html;
  }

  function inlineToHtml(text) {
    if (!text) return '';
    let out = escapeHtml(text);
    // Code spans
    out = out.replace(/`([^`]+)`/g, (m, g1) => `<code>${g1}</code>`);
    // Bold **text**
    out = out.replace(/\*\*([^*]+)\*\*/g, (m, g1) => `<strong>${g1}</strong>`);
    // Italic *text* or _text_
    out = out.replace(/\*(?!\*)([^*]+)\*/g, (m, g1) => `<em>${g1}</em>`);
    out = out.replace(/_([^_]+)_/g, (m, g1) => `<em>${g1}</em>`);
    // Links [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (m, text, url, title) => {
      const safe = sanitizeUrl(url);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer"${t}>${text}</a>`;
    });
    return out;
  }

  // Storage helpers
  function loadNotes() {
    try {
      const raw = localStorage.getItem(LS_NOTES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    // seed with one sample note
    const sample = {
      id: uid(),
      title: 'はじめに',
      content: '# ようこそ\n\n- 左でノートを選択\n- 右で編集 & プレビュー\n\n**ショートカット**\n- Ctrl+S: 保存\n- Ctrl+N: 新規\n\n```js\nconsole.log("Hello, MD Note!");\n```',
      updatedAt: now(),
    };
    return [sample];
  }

  function saveNotes() {
    localStorage.setItem(LS_NOTES, JSON.stringify(notes));
  }

  function loadSelectedId() {
    return localStorage.getItem(LS_SELECTED);
  }
  function saveSelectedId(id) {
    if (id) localStorage.setItem(LS_SELECTED, id);
  }

  // UI rendering
  function renderNoteList(filter = '') {
    const q = filter.trim().toLowerCase();
    noteList.innerHTML = '';
    const frag = document.createDocumentFragment();
    notes
      .slice()
      .sort((a,b) => b.updatedAt - a.updatedAt)
      .forEach((n) => {
        const matches = !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
        if (!matches) return;
        const li = document.createElement('li');
        li.dataset.id = n.id;
        if (n.id === selectedId) li.classList.add('active');
        const title = document.createElement('span');
        title.className = 'note-title';
        title.textContent = n.title || '(無題)';
        const meta = document.createElement('span');
        meta.className = 'note-meta';
        meta.textContent = `更新: ${fmtTime(n.updatedAt)}`;
        li.appendChild(title);
        li.appendChild(meta);
        li.addEventListener('click', () => selectNote(n.id));
        frag.appendChild(li);
      });
    noteList.appendChild(frag);
  }

  function selectNote(id) {
    const n = notes.find(n => n.id === id);
    if (!n) return;
    selectedId = id;
    saveSelectedId(id);
    titleInput.value = n.title;
    editor.value = n.content;
    updatePreview();
    setDirty(false);
    [...noteList.children].forEach(li => li.classList.toggle('active', li.dataset.id === id));
  }

  function setDirty(v) {
    dirty = v;
    if (dirty) {
      statusBadge.textContent = '未保存の変更';
      statusBadge.classList.add('unsaved');
      statusBadge.classList.remove('saved');
    } else {
      statusBadge.textContent = '保存済み';
      statusBadge.classList.add('saved');
      statusBadge.classList.remove('unsaved');
    }
  }

  function updatePreview() {
    preview.innerHTML = renderMarkdown(editor.value);
  }

  function saveCurrent() {
    const n = notes.find(n => n.id === selectedId);
    if (!n) return;
    n.title = titleInput.value.trim();
    n.content = editor.value;
    n.updatedAt = now();
    saveNotes();
    renderNoteList(searchInput.value);
    setDirty(false);
  }

  function newNote() {
    const n = { id: uid(), title: '', content: '', updatedAt: now() };
    notes.push(n);
    saveNotes();
    renderNoteList(searchInput.value);
    selectNote(n.id);
  }

  function deleteCurrent() {
    const idx = notes.findIndex(n => n.id === selectedId);
    if (idx === -1) return;
    const name = notes[idx].title || '(無題)';
    if (!confirm(`このノートを削除しますか？\n\n${name}`)) return;
    notes.splice(idx, 1);
    saveNotes();
    if (notes.length) {
      selectNote(notes[0].id);
    } else {
      newNote();
    }
    renderNoteList(searchInput.value);
  }

  function exportNotes() {
    const data = { version: 1, exportedAt: now(), notes };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mdnote-export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importNotes(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || !Array.isArray(parsed.notes)) throw new Error('Invalid');
        if (!confirm('現在のノートを置き換えます。よろしいですか？')) return;
        notes = parsed.notes.map(n => ({
          id: String(n.id || uid()),
          title: String(n.title || ''),
          content: String(n.content || ''),
          updatedAt: Number(n.updatedAt || now()),
        }));
        saveNotes();
        renderNoteList('');
        if (notes.length) selectNote(notes[0].id);
      } catch (e) {
        alert('インポートに失敗しました。JSON形式を確認してください。');
      }
    };
    reader.readAsText(file);
  }

  // Events
  editor.addEventListener('input', () => {
    setDirty(true);
    updatePreview();
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { saveCurrent(); }, 1400);
  });
  titleInput.addEventListener('input', () => {
    setDirty(true);
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { saveCurrent(); }, 1400);
    renderNoteList(searchInput.value); // live update titles
  });
  searchInput.addEventListener('input', () => renderNoteList(searchInput.value));
  newBtn.addEventListener('click', newNote);
  saveBtn.addEventListener('click', saveCurrent);
  deleteBtn.addEventListener('click', deleteCurrent);
  exportBtn.addEventListener('click', exportNotes);
  importInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importNotes(file);
    importInput.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
    if (e.key === 'Delete' && document.activeElement !== editor && document.activeElement !== titleInput) {
      e.preventDefault(); deleteCurrent();
    }
  });

  // Init
  function init() {
    notes = loadNotes();
    renderNoteList('');
    const last = loadSelectedId();
    if (last && notes.some(n => n.id === last)) {
      selectNote(last);
    } else if (notes.length) {
      selectNote(notes[0].id);
    } else {
      newNote();
    }
  }

  init();
})();

