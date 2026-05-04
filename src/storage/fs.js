/**
 * project: neptune — File System Access API Storage v1.0.0
 * Track L: File System Access API as Persistent Storage
 *
 * Provides persistent, user-visible storage for Neptune's state
 * using the File System Access API. Users select a directory on
 * their local filesystem, and Neptune stores bookmarks, history,
 * settings, cached resources, and logs as real files.
 *
 * Falls back to localStorage/IndexedDB when File System Access
 * API is unavailable (Firefox, Safari).
 *
 * Files created in the user-selected directory:
 *   neptune/bookmarks.json
 *   neptune/history.json
 *   neptune/settings.json
 *   neptune/cache/         — cached HTTP responses
 *   neptune/logs/          — request logs (JSON)
 *   neptune/backup/        — full state snapshots
 */

'use strict';

class FileSystemStorage {
  constructor(options = {}) {
    this.options = Object.assign({
      directoryName: 'neptune',
      autoSaveInterval: 30000,  // Auto-save every 30 seconds
      maxCacheSize: 100 * 1024 * 1024, // 100MB cache limit
      maxLogFiles: 50,
    }, options);

    this.dirHandle = null;
    this.initialized = false;
    this.available = false;
    this.dirty = new Set();     // Keys that need saving
    this.autoSaveTimer = null;
    this.cacheHandles = new Map(); // url → FileSystemFileHandle
    this.stats = {
      bytesWritten: 0,
      bytesRead: 0,
      filesCreated: 0,
      saves: 0,
      errors: 0,
    };

    // In-memory state (mirrored to files)
    this.state = {
      bookmarks: [],
      history: [],
      settings: {},
    };
  }

  // ── Detection ──────────────────────────────────────
  static async detect() {
    if (typeof window === 'undefined') {
      return { available: false, reason: 'Not in browser context' };
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      return { available: false, reason: 'File System Access API not supported' };
    }

    // Check if we already have permission
    try {
      // Can't check without prompting — user must click
      return { available: true, requiresUserGesture: true };
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  static getCapabilities() {
    return {
      name: 'file-system-access',
      tier: 'auxiliary',
      priority: 0,
      requiresUserGesture: true,
      browserSupport: ['chrome', 'edge', 'opera'],
      fallback: 'localStorage',
    };
  }

  // ── Initialization ────────────────────────────────
  async init() {
    if (this.initialized) return true;

    // Try to restore previous directory handle from IndexedDB
    // (Chrome allows storing handles in IDB for re-granting permission)
    try {
      const stored = await this._loadHandleFromIDB();
      if (stored) {
        const permission = await stored.queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          this.dirHandle = stored;
          this.available = true;
          console.log('[FS] Restored directory handle from IDB');
        }
      }
    } catch (e) {
      // IDB may not be available in SW context
    }

    // If no stored handle, check for localStorage fallback
    if (!this.available) {
      this._initLocalStorageFallback();
    }

    // Load state from files
    if (this.available && this.dirHandle) {
      await this._loadAllState();
    }

    // Start auto-save timer
    if (this.options.autoSaveInterval > 0) {
      this.autoSaveTimer = setInterval(
        () => this._autoSave(),
        this.options.autoSaveInterval
      );
    }

    this.initialized = true;
    console.log('[FS] Initialized — ' + (this.available ? 'file system' : 'localStorage fallback'));
    return true;
  }

  // ── Directory Selection ───────────────────────────
  async selectDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('File System Access API not available');
    }

    try {
      this.dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents',
      });

      // Create neptune subdirectory
      await this._ensureDir('');

      // Store handle for future sessions
      await this._saveHandleToIDB(this.dirHandle);

      this.available = true;

      // Ensure subdirectories exist
      await this._ensureDir('cache');
      await this._ensureDir('logs');
      await this._ensureDir('backup');

      await this._loadAllState();
      console.log('[FS] Directory selected and ready');
      return true;
    } catch (e) {
      if (e.name === 'AbortError') {
        console.log('[FS] Directory selection cancelled');
      } else {
        console.error('[FS] Directory selection failed:', e.message);
      }
      this._initLocalStorageFallback();
      return false;
    }
  }

  // ── State Persistence ─────────────────────────────
  async saveBookmarks(bookmarks) {
    this.state.bookmarks = bookmarks;
    this._markDirty('bookmarks');
    return this._writeJSON('bookmarks.json', bookmarks);
  }

  async saveHistory(history) {
    this.state.history = history;
    this._markDirty('history');
    return this._writeJSON('history.json', history);
  }

  async saveSettings(settings) {
    this.state.settings = settings;
    this._markDirty('settings');
    return this._writeJSON('settings.json', settings);
  }

  async loadBookmarks() {
    if (this.state.bookmarks.length > 0) return this.state.bookmarks;
    const data = await this._readJSON('bookmarks.json');
    if (data) this.state.bookmarks = data;
    return this.state.bookmarks;
  }

  async loadHistory() {
    if (this.state.history.length > 0) return this.state.history;
    const data = await this._readJSON('history.json');
    if (data) this.state.history = data;
    return this.state.history;
  }

  async loadSettings() {
    if (Object.keys(this.state.settings).length > 0) return this.state.settings;
    const data = await this._readJSON('settings.json');
    if (data) this.state.settings = data;
    return this.state.settings;
  }

  async loadAllState() {
    const [bookmarks, history, settings] = await Promise.all([
      this.loadBookmarks(),
      this.loadHistory(),
      this.loadSettings(),
    ]);
    return { bookmarks, history, settings };
  }

  // ── Cache Storage ─────────────────────────────────
  async cacheResource(url, response) {
    if (!this.available || !this.dirHandle) return false;

    try {
      const key = this._urlToCacheKey(url);
      const cacheDir = await this._getOrCreateDir('cache');

      // Check cache size limit
      const currentSize = await this._getCacheSize();
      const contentLength = parseInt(response.headers.get('content-length') || '0');
      if (currentSize + contentLength > this.options.maxCacheSize) {
        await this._pruneCache(currentSize + contentLength - this.options.maxCacheSize);
      }

      const fileHandle = await cacheDir.getFileHandle(key, { create: true });
      const writable = await fileHandle.createWritable();

      // Write metadata header + body
      const meta = JSON.stringify({
        url,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        cachedAt: Date.now(),
        contentLength,
      });

      const buf = await response.clone().arrayBuffer();
      const headerBytes = new TextEncoder().encode(meta + '\n');

      await writable.write(headerBytes);
      await writable.write(buf);
      await writable.close();

      this.cacheHandles.set(url, fileHandle);
      this.stats.bytesWritten += headerBytes.length + buf.byteLength;
      this.stats.filesCreated++;
      return true;
    } catch (e) {
      this.stats.errors++;
      console.error('[FS] Cache write failed:', e.message);
      return false;
    }
  }

  async getCachedResource(url, maxAge = 86400000) {
    if (!this.available || !this.dirHandle) return null;

    try {
      const key = this._urlToCacheKey(url);
      const cacheDir = await this._getOrCreateDir('cache');
      let fileHandle;

      try {
        fileHandle = await cacheDir.getFileHandle(key);
      } catch (e) {
        return null; // File not found
      }

      const file = await fileHandle.getFile();
      const text = await file.text();
      const newlineIdx = text.indexOf('\n');
      if (newlineIdx < 0) return null;

      const meta = JSON.parse(text.substring(0, newlineIdx));
      const body = text.substring(newlineIdx + 1);

      // Check age
      if (Date.now() - meta.cachedAt > maxAge) {
        await cacheDir.removeEntry(key);
        return null;
      }

      this.stats.bytesRead += file.size;

      return new Response(body, {
        status: meta.status,
        statusText: meta.statusText,
        headers: {
          'Content-Type': meta.contentType,
          'X-Neptune-Cached-FS': 'true',
          'X-Neptune-Cached-At': meta.cachedAt.toString(),
        },
      });
    } catch (e) {
      return null;
    }
  }

  async clearCache() {
    if (!this.available || !this.dirHandle) return;
    try {
      await this.dirHandle.removeEntry('cache', { recursive: true });
      await this._ensureDir('cache');
      this.cacheHandles.clear();
      console.log('[FS] Cache cleared');
    } catch (e) {
      console.error('[FS] Cache clear failed:', e.message);
    }
  }

  // ── Log Storage ───────────────────────────────────
  async appendLog(entry) {
    if (!this.available || !this.dirHandle) return false;

    try {
      const logDir = await this._getOrCreateDir('logs');
      const date = new Date().toISOString().split('T')[0];
      const filename = `neptune-${date}.jsonl`;

      const fileHandle = await logDir.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: true });

      // Seek to end
      const file = await fileHandle.getFile();
      const line = JSON.stringify(entry) + '\n';
      await writable.write({ type: 'write', position: file.size, data: line });
      await writable.close();

      this.stats.bytesWritten += line.length;

      // Prune old logs
      await this._pruneLogs(logDir);
      return true;
    } catch (e) {
      this.stats.errors++;
      return false;
    }
  }

  // ── Backup & Export ───────────────────────────────
  async createBackup() {
    if (!this.available || !this.dirHandle) return null;

    try {
      const backupDir = await this._getOrCreateDir('backup');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `neptune-backup-${timestamp}.json`;

      const allState = await this.loadAllState();
      const backup = {
        version: '1.0.0',
        timestamp: Date.now(),
        ...allState,
        stats: this.getStats(),
      };

      await this._writeJSON(`backup/${filename}`, backup);
      console.log('[FS] Backup created:', filename);
      return backup;
    } catch (e) {
      console.error('[FS] Backup failed:', e.message);
      return null;
    }
  }

  async listBackups() {
    if (!this.available || !this.dirHandle) return [];
    try {
      const backupDir = await this._getOrCreateDir('backup');
      const backups = [];
      for await (const [name] of backupDir.entries()) {
        if (name.endsWith('.json')) backups.push(name);
      }
      return backups.sort().reverse();
    } catch (e) {
      return [];
    }
  }

  async restoreBackup(filename) {
    if (!this.available || !this.dirHandle) return false;
    try {
      const data = await this._readJSON(`backup/${filename}`);
      if (!data) return false;

      if (data.bookmarks) await this.saveBookmarks(data.bookmarks);
      if (data.history) await this.saveHistory(data.history);
      if (data.settings) await this.saveSettings(data.settings);

      console.log('[FS] Restored from backup:', filename);
      return true;
    } catch (e) {
      console.error('[FS] Restore failed:', e.message);
      return false;
    }
  }

  // ── Utilities ─────────────────────────────────────
  getStats() {
    return {
      ...this.stats,
      available: this.available,
      initialized: this.initialized,
      dirtyKeys: Array.from(this.dirty),
      bookmarksCount: this.state.bookmarks.length,
      historyCount: this.state.history.length,
    };
  }

  async destroy() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    // Flush any pending writes
    await this._autoSave();
    this.initialized = false;
    this.available = false;
    this.dirHandle = null;
    this.cacheHandles.clear();
  }

  // ── Private Methods ───────────────────────────────
  async _loadAllState() {
    try {
      await Promise.all([
        this.loadBookmarks(),
        this.loadHistory(),
        this.loadSettings(),
      ]);
    } catch (e) {
      console.warn('[FS] State load partial:', e.message);
    }
  }

  async _writeJSON(relativePath, data) {
    if (!this.available || !this.dirHandle) {
      this._saveToLocalStorage(relativePath, data);
      return false;
    }

    try {
      const parts = relativePath.split('/');
      const filename = parts.pop();
      let currentDir = this.dirHandle;

      for (const part of parts) {
        currentDir = await currentDir.getDirectoryHandle(part, { create: true });
      }

      const fileHandle = await currentDir.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      const json = JSON.stringify(data, null, 2);
      await writable.write(json);
      await writable.close();

      this.stats.bytesWritten += json.length;
      this.stats.saves++;
      return true;
    } catch (e) {
      this.stats.errors++;
      console.error('[FS] Write failed:', relativePath, e.message);
      return false;
    }
  }

  async _readJSON(relativePath) {
    if (!this.available || !this.dirHandle) {
      return this._loadFromLocalStorage(relativePath);
    }

    try {
      const parts = relativePath.split('/');
      const filename = parts.pop();
      let currentDir = this.dirHandle;

      for (const part of parts) {
        try {
          currentDir = await currentDir.getDirectoryHandle(part);
        } catch (e) {
          return null;
        }
      }

      const fileHandle = await currentDir.getFileHandle(filename);
      const file = await fileHandle.getFile();
      const text = await file.text();
      this.stats.bytesRead += file.size;
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  async _ensureDir(name) {
    if (!this.dirHandle) return null;
    try {
      return await this.dirHandle.getDirectoryHandle(name, { create: true });
    } catch (e) {
      return null;
    }
  }

  async _getOrCreateDir(name) {
    return this._ensureDir(name);
  }

  _urlToCacheKey(url) {
    // Create safe filename from URL
    return url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .substring(0, 200) + '.cache';
  }

  async _getCacheSize() {
    if (!this.available || !this.dirHandle) return 0;
    try {
      const cacheDir = await this._getOrCreateDir('cache');
      let size = 0;
      for await (const [, handle] of cacheDir.entries()) {
        if (handle.kind === 'file') {
          try {
            const file = await handle.getFile();
            size += file.size;
          } catch (e) {}
        }
      }
      return size;
    } catch (e) {
      return 0;
    }
  }

  async _pruneCache(bytesToFree) {
    if (!this.available || !this.dirHandle) return;
    try {
      const cacheDir = await this._getOrCreateDir('cache');
      const entries = [];
      for await (const [name, handle] of cacheDir.entries()) {
        if (handle.kind === 'file') {
          try {
            const file = await handle.getFile();
            entries.push({ name, mtime: file.lastModified, size: file.size });
          } catch (e) {}
        }
      }
      // Sort oldest first
      entries.sort((a, b) => a.mtime - b.mtime);

      let freed = 0;
      for (const entry of entries) {
        if (freed >= bytesToFree) break;
        await cacheDir.removeEntry(entry.name);
        freed += entry.size;
      }
      console.log('[FS] Pruned cache: freed ' + (freed / 1024).toFixed(1) + ' KB');
    } catch (e) {
      console.error('[FS] Cache prune failed:', e.message);
    }
  }

  async _pruneLogs(logDir) {
    try {
      const entries = [];
      for await (const [name] of logDir.entries()) {
        if (name.endsWith('.jsonl')) entries.push(name);
      }
      entries.sort();
      while (entries.length > this.options.maxLogFiles) {
        await logDir.removeEntry(entries.shift());
      }
    } catch (e) {}
  }

  _markDirty(key) {
    this.dirty.add(key);
  }

  async _autoSave() {
    if (this.dirty.size === 0) return;
    const keys = Array.from(this.dirty);
    this.dirty.clear();

    for (const key of keys) {
      switch (key) {
        case 'bookmarks':
          await this._writeJSON('bookmarks.json', this.state.bookmarks);
          break;
        case 'history':
          await this._writeJSON('history.json', this.state.history);
          break;
        case 'settings':
          await this._writeJSON('settings.json', this.state.settings);
          break;
      }
    }
  }

  // ── IndexedDB Handle Persistence ───────────────────
  async _saveHandleToIDB(handle) {
    try {
      const db = await this._openIDB();
      const tx = db.transaction('handles', 'readwrite');
      const store = tx.objectStore('handles');
      await store.put(handle, 'dirHandle');
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch (e) {
      // IDB may not be available
    }
  }

  async _loadHandleFromIDB() {
    try {
      const db = await this._openIDB();
      const tx = db.transaction('handles', 'readonly');
      const store = tx.objectStore('handles');
      const handle = await new Promise(r => {
        const req = store.get('dirHandle');
        req.onsuccess = () => r(req.result);
        req.onerror = () => r(null);
      });
      return handle || null;
    } catch (e) {
      return null;
    }
  }

  async _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('neptune-fs-storage', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('handles');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ── localStorage Fallback ──────────────────────────
  _initLocalStorageFallback() {
    this.available = false;
    console.log('[FS] Using localStorage fallback');
    // Load from localStorage
    try {
      const raw = localStorage.getItem('neptune_state');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.bookmarks) this.state.bookmarks = parsed.bookmarks;
        if (parsed.history) this.state.history = parsed.history;
        if (parsed.settings) this.state.settings = parsed.settings;
      }
    } catch (e) {}
  }

  _saveToLocalStorage(key, data) {
    try {
      const stored = JSON.parse(localStorage.getItem('neptune_state') || '{}');
      switch (key) {
        case 'bookmarks.json': stored.bookmarks = data; break;
        case 'history.json': stored.history = data; break;
        case 'settings.json': stored.settings = data; break;
      }
      localStorage.setItem('neptune_state', JSON.stringify(stored));
    } catch (e) {}
  }

  _loadFromLocalStorage(key) {
    try {
      const stored = JSON.parse(localStorage.getItem('neptune_state') || '{}');
      switch (key) {
        case 'bookmarks.json': return stored.bookmarks || null;
        case 'history.json': return stored.history || null;
        case 'settings.json': return stored.settings || null;
        default: return null;
      }
    } catch (e) {
      return null;
    }
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileSystemStorage;
}
if (typeof window !== 'undefined') {
  window.FileSystemStorage = FileSystemStorage;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FileSystemStorage = FileSystemStorage;
}
