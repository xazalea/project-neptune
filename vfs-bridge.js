/**
 * Neptune VFS Bridge
 * Maps WASM linear memory to IndexedDB for persistent storage.
 * Provides a POSIX-like filesystem API to the WASM kernel.
 */

const DB_NAME = 'neptune-vfs';
const DB_VERSION = 1;

class NeptuneVFS {
  constructor() {
    this.db = null;
    this.ready = false;
    this.mountPoints = new Map();
    this.fdCounter = 3; // 0=stdin, 1=stdout, 2=stderr
    this.openFiles = new Map();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.ready = true;
        console.log('[VFS] IndexedDB filesystem mounted');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Files store: path -> { data, metadata }
        if (!db.objectStoreNames.contains('files')) {
          const filesStore = db.createObjectStore('files', { keyPath: 'path' });
          filesStore.createIndex('parent', 'parent', { unique: false });
          filesStore.createIndex('modified', 'modified', { unique: false });
        }

        // Inodes store for directory entries
        if (!db.objectStoreNames.contains('inodes')) {
          db.createObjectStore('inodes', { keyPath: 'path' });
        }

        // Symlinks store
        if (!db.objectStoreNames.contains('symlinks')) {
          db.createObjectStore('symlinks', { keyPath: 'path' });
        }
      };
    });
  }

  // ==========================
  // POSIX-like API
  // ==========================

  async open(path, flags = 'r') {
    const fd = this.fdCounter++;

    try {
      const file = await this._getFile(path);

      if (!file && flags.includes('w')) {
        // Create new file
        await this._putFile(path, {
          path,
          parent: this._parentDir(path),
          data: new Uint8Array(0),
          modified: Date.now(),
          created: Date.now(),
          permissions: 0o644,
          size: 0,
        });
      } else if (!file) {
        throw new Error(`ENOENT: ${path}`);
      }

      this.openFiles.set(fd, {
        path,
        flags,
        position: flags.includes('a') ? (file?.data?.length || 0) : 0,
      });

      return fd;
    } catch (e) {
      throw new Error(`Open failed: ${e.message}`);
    }
  }

  async read(fd, buffer, offset, length) {
    const handle = this.openFiles.get(fd);
    if (!handle) throw new Error(`EBADF: Invalid fd ${fd}`);

    const file = await this._getFile(handle.path);
    if (!file) throw new Error(`ENOENT: ${handle.path}`);

    const start = handle.position;
    const end = Math.min(start + length, file.data.length);
    const bytesRead = end - start;

    buffer.set(file.data.slice(start, end), offset);
    handle.position = end;

    return bytesRead;
  }

  async write(fd, buffer, offset, length) {
    const handle = this.openFiles.get(fd);
    if (!handle) throw new Error(`EBADF: Invalid fd ${fd}`);

    if (!handle.flags.includes('w') && !handle.flags.includes('a') && !handle.flags.includes('+')) {
      throw new Error(`EBADF: File not opened for writing`);
    }

    const file = await this._getFile(handle.path) || {
      path: handle.path,
      parent: this._parentDir(handle.path),
      data: new Uint8Array(0),
      modified: Date.now(),
      created: Date.now(),
      permissions: 0o644,
    };

    const newData = new Uint8Array(Math.max(file.data.length, handle.position + length));
    newData.set(file.data);
    newData.set(buffer.slice(offset, offset + length), handle.position);

    file.data = newData;
    file.size = newData.length;
    file.modified = Date.now();

    await this._putFile(handle.path, file);
    handle.position += length;

    return length;
  }

  async close(fd) {
    if (!this.openFiles.has(fd)) return;
    this.openFiles.delete(fd);
  }

  async stat(path) {
    const file = await this._getFile(path);
    if (!file) throw new Error(`ENOENT: ${path}`);

    return {
      path: file.path,
      size: file.size,
      modified: file.modified,
      created: file.created,
      permissions: file.permissions,
    };
  }

  async readdir(path) {
    const parent = path.endsWith('/') ? path : path + '/';

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const index = store.index('parent');
      const request = index.openCursor(IDBKeyRange.only(parent));

      const entries = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          entries.push({
            name: cursor.value.path.split('/').pop(),
            path: cursor.value.path,
            size: cursor.value.size,
            modified: cursor.value.modified,
          });
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async mkdir(path, mode = 0o755) {
    const dirEntry = {
      path: path.endsWith('/') ? path : path + '/',
      parent: this._parentDir(path),
      data: null,
      modified: Date.now(),
      created: Date.now(),
      permissions: mode,
      size: 0,
      isDirectory: true,
    };

    await this._putFile(dirEntry.path, dirEntry);
    return dirEntry.path;
  }

  async unlink(path) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const request = store.delete(path);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ==========================
  // WASM Memory Bridge
  // ==========================

  async syncToWASM(wasmMemory, baseOffset = 0) {
    // Serialize all VFS entries into WASM memory
    const files = await this._getAllFiles();
    const encoder = new TextEncoder();

    let offset = baseOffset;
    const header = {
      magic: 'NPTN',
      version: 1,
      count: files.length,
      entries: [],
    };

    // First pass: calculate sizes and build header
    for (const file of files) {
      const pathBytes = encoder.encode(file.path);
      header.entries.push({
        pathLen: pathBytes.length,
        dataLen: file.data?.length || 0,
        modified: file.modified,
        permissions: file.permissions,
      });
    }

    // Serialize to memory
    const headerJson = JSON.stringify(header);
    const headerBytes = encoder.encode(headerJson);

    // Write header length (4 bytes)
    const view = new DataView(wasmMemory.buffer);
    view.setUint32(offset, headerBytes.length, true);
    offset += 4;

    // Write header
    const headerArray = new Uint8Array(wasmMemory.buffer, offset, headerBytes.length);
    headerArray.set(headerBytes);
    offset += headerBytes.length;

    // Write each file entry
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const pathBytes = encoder.encode(file.path);
      const dataLen = file.data?.length || 0;

      // Path length (4 bytes)
      view.setUint32(offset, pathBytes.length, true);
      offset += 4;

      // Path
      new Uint8Array(wasmMemory.buffer, offset, pathBytes.length).set(pathBytes);
      offset += pathBytes.length;

      // Data length (4 bytes)
      view.setUint32(offset, dataLen, true);
      offset += 4;

      // Data
      if (dataLen > 0 && file.data) {
        new Uint8Array(wasmMemory.buffer, offset, dataLen).set(file.data);
        offset += dataLen;
      }
    }

    return offset - baseOffset;
  }

  async syncFromWASM(wasmMemory, baseOffset = 0) {
    // Deserialize VFS entries from WASM memory
    const view = new DataView(wasmMemory.buffer);
    let offset = baseOffset;

    const headerLen = view.getUint32(offset, true);
    offset += 4;

    const headerBytes = new Uint8Array(wasmMemory.buffer, offset, headerLen);
    offset += headerLen;

    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(headerBytes));

    if (header.magic !== 'NPTN') {
      throw new Error('Invalid VFS snapshot magic');
    }

    for (let i = 0; i < header.count; i++) {
      const pathLen = view.getUint32(offset, true);
      offset += 4;

      const path = decoder.decode(new Uint8Array(wasmMemory.buffer, offset, pathLen));
      offset += pathLen;

      const dataLen = view.getUint32(offset, true);
      offset += 4;

      let data = null;
      if (dataLen > 0) {
        data = new Uint8Array(wasmMemory.buffer, offset, dataLen);
        offset += dataLen;
      }

      await this._putFile(path, {
        path,
        parent: this._parentDir(path),
        data: data ? new Uint8Array(data) : null,
        modified: header.entries[i]?.modified || Date.now(),
        permissions: header.entries[i]?.permissions || 0o644,
        size: dataLen,
      });
    }

    console.log(`[VFS] Restored ${header.count} files from WASM memory`);
    return header.count;
  }

  // ==========================
  // Snapshot Export / Import
  // ==========================

  async exportSnapshot() {
    const files = await this._getAllFiles();
    const snapshot = {
      version: '0.1.0',
      timestamp: Date.now(),
      files: files.map(f => ({
        path: f.path,
        data: f.data ? Array.from(f.data) : null,
        modified: f.modified,
        permissions: f.permissions,
        isDirectory: f.isDirectory || false,
      })),
    };

    const json = JSON.stringify(snapshot);
    const compressed = await this._compress(json);
    return btoa(compressed);
  }

  async importSnapshot(base64Data) {
    const compressed = atob(base64Data);
    const json = await this._decompress(compressed);
    const snapshot = JSON.parse(json);

    // Clear existing data
    await this._clearAll();

    // Restore files
    for (const file of snapshot.files) {
      await this._putFile(file.path, {
        path: file.path,
        parent: this._parentDir(file.path),
        data: file.data ? new Uint8Array(file.data) : null,
        modified: file.modified,
        permissions: file.permissions,
        size: file.data ? file.data.length : 0,
        isDirectory: file.isDirectory,
      });
    }

    console.log(`[VFS] Imported snapshot with ${snapshot.files.length} files`);
    return snapshot.files.length;
  }

  // ==========================
  // Internal Helpers
  // ==========================

  async _getFile(path) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const request = store.get(path);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async _putFile(path, data) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async _getAllFiles() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const request = store.openCursor();

      const files = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          files.push(cursor.value);
          cursor.continue();
        } else {
          resolve(files);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async _clearAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  _parentDir(path) {
    const parts = path.split('/').filter(p => p);
    parts.pop();
    return parts.length > 0 ? '/' + parts.join('/') + '/' : '/';
  }

  async _compress(str) {
    // Simple compression using CompressionStream if available
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([str]).stream();
      const compressed = stream.pipeThrough(new CompressionStream('gzip'));
      const reader = compressed.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return new Blob(chunks).text();
    }
    return str; // Fallback: no compression
  }

  async _decompress(str) {
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([str]).stream();
      const decompressed = stream.pipeThrough(new DecompressionStream('gzip'));
      const reader = decompressed.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return new Blob(chunks).text();
    }
    return str;
  }
}

// ==========================
// Singleton Export
// ==========================

const neptuneVFS = new NeptuneVFS();

// Message bridge for Service Worker communication
if (typeof self !== 'undefined' && self.postMessage) {
  self.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    switch (data.type) {
      case 'VFS_INIT':
        await neptuneVFS.init();
        event.source?.postMessage({ type: 'VFS_READY' });
        break;

      case 'VFS_EXPORT':
        const snapshot = await neptuneVFS.exportSnapshot();
        event.source?.postMessage({ type: 'VFS_SNAPSHOT', data: snapshot });
        break;

      case 'VFS_IMPORT':
        await neptuneVFS.importSnapshot(data.snapshot);
        event.source?.postMessage({ type: 'VFS_IMPORTED' });
        break;

      case 'VFS_SYNC_TO_WASM':
        const bytes = await neptuneVFS.syncToWASM(data.memory, data.offset);
        event.source?.postMessage({ type: 'VFS_SYNCED', bytes });
        break;

      case 'VFS_SYNC_FROM_WASM':
        const count = await neptuneVFS.syncFromWASM(data.memory, data.offset);
        event.source?.postMessage({ type: 'VFS_RESTORED', count });
        break;
    }
  });
}

// Also export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NeptuneVFS, neptuneVFS };
}
