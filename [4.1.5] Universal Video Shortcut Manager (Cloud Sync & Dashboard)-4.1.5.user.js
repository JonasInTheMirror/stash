// ==UserScript==
// @name         [5.0.1] Universal Video Shortcut Manager (Offline-First Git Sync)
// @namespace    http://tampermonkey.net/
// @version      5.0.1
// @description  True Offline-First Architecture, 3-Way Git Merging, Advanced Dashboard
// @author       JonasInTheMirror
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      dkptmjfzlluczjvvmruz.supabase.co
// @downloadURL  https://gist.githubusercontent.com/JonasInTheMirror/a7dbe0be6895d8d175ac6c53549217d1/raw/VideoShortcutManager.user.js
// @updateURL    https://gist.githubusercontent.com/JonasInTheMirror/a7dbe0be6895d8d175ac6c53549217d1/raw/VideoShortcutManager.user.js
// ==/UserScript==

(function () {
  'use strict';

  window.VSM = window.VSM || {};

  // ==========================================
  // 0. TELEMETRY & LOGGING ENGINE
  // ==========================================
  window.VSM.Log = {
    level: 'DEBUG',
    _emit(level, color, module, msg, data) {
      const time = new Date().toISOString().split('T')[1].slice(0, -1);
      const prefix = `%c[${time}][VSM ${module}] [${level}]`;
      const style = `color:${color}; font-weight:bold;`;
      if (data !== undefined) {
        console.log(`${prefix} ${msg}`, style, JSON.parse(JSON.stringify(data)));
      } else {
        console.log(`${prefix} ${msg}`, style);
      }
    },
    debug: (mod, msg, data) => window.VSM.Log._emit('DEBUG', '#888', mod, msg, data),
    info: (mod, msg, data) => window.VSM.Log._emit('INFO', '#00d1b2', mod, msg, data),
    warn: (mod, msg, data) => window.VSM.Log._emit('WARN', '#ffdd57', mod, msg, data),
    error: (mod, msg, data) => window.VSM.Log._emit('ERROR', '#ff3860', mod, msg, data)
  };

  // ==========================================
  // TRUSTED TYPES BYPASS
  // ==========================================
  let ttPolicy = null;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try { ttPolicy = window.trustedTypes.createPolicy('vsm-trusted-policy', { createHTML: (s) => s }); }
    catch (e) { window.VSM.Log.warn('Core', 'TrustedTypes policy fallback', e); }
  }
  window.VSM.safeHTML = (html) => ttPolicy ? ttPolicy.createHTML(html) : html;

  // ==========================================
  // GLOBAL HOTKEY SHIELD
  // ==========================================
  ['keydown', 'keyup', 'keypress'].forEach(evt => {
    window.addEventListener(evt, (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
        if (e.target.closest('.vsm-dash-overlay') || e.target.closest('.vsm-popup') || e.target.closest('.vsm-overlay-container')) {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      }
    }, true);
  });

  // ==========================================
  // 1. STORAGE MODULE (True Git Architecture)
  // ==========================================
  window.VSM.Storage = class {
    constructor(app) {
      this.app = app;
      this.currentFilepath = null;
      this.currentSceneKey = null;
      this.currentSceneMetadata = { id: null, title: 'Unknown Video', studio: '', code: '' };

      this.lastSyncedCloudTimes = {};
      this._db = null;

      // NEW: Initialize the Push Queue
      this.vsm_push_queue = [];
      this.isQueueProcessing = false;

      this.pushDebounceTimer = null;
      this.pullIntervalTimer = null;
      this.dirtyKeys = new Set();

      this.DEFAULT_SETTINGS = {
        lastUpdated: 0,
        baseCloudTs: 0,
        useStashDB: false,
        useSupabase: true,
        supabaseUrl: 'https://dkptmjfzlluczjvvmruz.supabase.co',
        supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcHRtamZ6bGx1Y3pqdnZtcnV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MTAxMzcsImV4cCI6MjA5MzM4NjEzN30.fHkD4OYoeGCjbjSE9C6zqcKnEla51ihNwcOyEbKnI2Y',

        syncPullInterval: 30,
        syncPullUnit: 60000,
        autoPushDelay: 8,
        autoPushUnit: 1000,

        mergeImports: true,
        microAdjustStep: 0.1,
        zoomSensitivity: 0.15,
        panSensitivity: 1.0,
        navBookmarksOnly: false,
        customShortcuts: {
          'Z': { action: 'seekBackward', value: 5 },
          'X': { action: 'seekForward', value: 5 },
          'S': { action: 'toggleLoop', value: null },
          'C': { action: 'addLoopPoint', value: null },
          'V': { action: 'toggleOverlayVisibility', value: null },
          'B': { action: 'clearLoops', value: null },
          'D': { action: 'splitRegion', value: null },
          'Q': { action: 'prevRegion', value: null },
          'W': { action: 'nextRegion', value: null }
        },
        hideUI: { progressBar: false, controlBar: false, overlay: false }
      };
      this.settings = { ...this.DEFAULT_SETTINGS };

      this.syncChannel = new BroadcastChannel('vsm_sync_channel');
      this.syncChannel.onmessage = (e) => {
        if (e.data && e.data.key === "vsm_global_settings" && e.data.newValue) {
          try {
            const freshSettings = JSON.parse(e.data.newValue);
            this.settings = { ...this.settings, ...freshSettings };
            this.startPullTimer();
            if (this.app.ui) this.app.ui.refreshAll();
          } catch (err) { }
        } else if (e.data && e.data.action === "reload_scene") {
          if (e.data.key === this.currentSceneKey) {
            this.loadSceneData();
            if (this.app.ui) this.app.ui.refreshAll();
          }
        }
      };
    }

    async getDB() {
      if (this._db) return this._db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('VSM_Database', 1);
        req.onupgradeneeded = (e) => { if (!e.target.result.objectStoreNames.contains('VSM_Store')) e.target.result.createObjectStore('VSM_Store'); };
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => reject(req.error);
      });
    }

    async idbGet(key) {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const req = db.transaction('VSM_Store', 'readonly').objectStore('VSM_Store').get(key);
        req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null);
      });
    }

    async idbSet(key, value) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction('VSM_Store', 'readwrite').objectStore('VSM_Store').put(value, key);
        req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
      });
    }

    async idbRemove(key) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction('VSM_Store', 'readwrite').objectStore('VSM_Store').delete(key);
        req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
      });
    }

    async idbKeys() {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const req = db.transaction('VSM_Store', 'readonly').objectStore('VSM_Store').getAllKeys();
        req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
      });
    }

    // Atomic read-modify-write: adds one key to the queue Set in a single IDB transaction.
    // Prevents multi-tab race where two tabs read the old queue and each overwrites the other.
    async idbAtomicQueueAdd(queueKey, itemToAdd) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('VSM_Store', 'readwrite');
        const store = tx.objectStore('VSM_Store');
        const getReq = store.get(queueKey);
        getReq.onsuccess = () => {
          const queue = getReq.result ? new Set(JSON.parse(getReq.result)) : new Set();
          queue.add(itemToAdd);
          const putReq = store.put(JSON.stringify(Array.from(queue)), queueKey);
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    }

    // Atomic read-modify-write: removes a set of keys from the queue in a single IDB transaction.
    async idbAtomicQueueRemove(queueKey, itemsToRemove) {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('VSM_Store', 'readwrite');
        const store = tx.objectStore('VSM_Store');
        const getReq = store.get(queueKey);
        getReq.onsuccess = () => {
          const queue = getReq.result ? new Set(JSON.parse(getReq.result)) : new Set();
          itemsToRemove.forEach(k => queue.delete(k));
          const putReq = store.put(JSON.stringify(Array.from(queue)), queueKey);
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    }

    get lib() {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      return w.stash7dJx1qP || w.csLib;
    }

    getSceneId() {
      const match = window.location.pathname.match(/\/scenes\/(\d+)/);
      return match ? match[1] : 'universal_web_video';
    }

    async hashPath(path) {
      const msgUint8 = new TextEncoder().encode(path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return 'vsm_hash_' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    getOsHash(fileObj) {
      if (!fileObj) return null;
      if (fileObj.fingerprints && Array.isArray(fileObj.fingerprints)) {
        const os = fileObj.fingerprints.find(f => f.type === 'oshash');
        if (os) return os.value;
      }
      return fileObj.fingerprint || null;
    }

    async fetchSceneMetadata(sceneId) {
      let meta = { id: sceneId, title: document.title, path: window.location.href.split('?')[0], studio: '', code: '', oshash: null, PHash: null, size: null, mod_time: null, duration: null };
      if (!sceneId || sceneId === 'universal_web_video') return meta;

      if (/^\d+$/.test(sceneId)) {
        const queries = [
          `query { findScene(id: "${sceneId}") { title code files { path size mod_time duration fingerprints { type value } } studio { name } } }`,
          `query { findScene(id: "${sceneId}") { title code files { path size mod_time duration } studio { name } } }`,
          `query { findScene(id: "${sceneId}") { title code files { path size mod_time duration } studio { name } } }`,
          `query { findScene(id: "${sceneId}") { title code files { path } studio { name } } }`
        ];

        for (const q of queries) {
          try {
            const res = await fetch('/graphql', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ query: q })
            });
            const text = await res.text();
            let json;
            try { json = JSON.parse(text); } catch (err) { continue; }

            if (!res.ok || json.errors) continue;

            const s = json.data?.findScene;
            if (s) {
              meta.title = s.title || meta.title; meta.code = s.code || ''; meta.studio = s.studio?.name || '';
              if (s.files?.[0]) {
                const file = s.files[0];
                meta.path = file.path; meta.size = file.size; meta.mod_time = file.mod_time; meta.duration = file.duration;
                if (file.fingerprints) {
                  const osFp = file.fingerprints.find(f => f.type === 'oshash'); if (osFp) meta.oshash = osFp.value;
                  const pFp = file.fingerprints.find(f => f.type === 'phash'); if (pFp) meta.PHash = pFp.value;
                } else { meta.oshash = this.getOsHash(file); }
              }
              break;
            }
          } catch (e) { }
        }
      }
      return meta;
    }

    async scrapeAllStashMetadata() {
      const startTime = performance.now();
      window.VSM.Log.info('Scraper', 'Initiating Global Stash GraphQL Scrape...');
      try {
        const queries = [
          `query { findScenes(filter:{per_page:-1}) { scenes { id title code files { path size mod_time duration fingerprints { type value } } studio { name } } } }`,
          `query { findScenes(filter:{per_page:-1}) { scenes { id title code files { path size mod_time duration } studio { name } } } }`,
          `query { findScenes(filter:{per_page:-1}) { scenes { id title code files { path size mod_time duration } studio { name } } } }`,
          `query { findScenes(filter:{per_page:-1}) { scenes { id title code files { path } studio { name } } } }`
        ];

        let scenes = null;
        for (const q of queries) {
          try {
            const res = await fetch('/graphql', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ query: q })
            });
            const text = await res.text(); const json = JSON.parse(text);
            if (!res.ok || json.errors) continue;
            scenes = json.data?.findScenes?.scenes; if (scenes) break;
          } catch (err) { continue; }
        }

        if (!scenes) { window.VSM.Log.error('Scraper', 'All GraphQL scrape attempts failed.'); return 0; }

        const hashMap = {};
        for (const s of scenes) {
          if (s.files && s.files.length > 0) {
            const file = s.files[0];
            const cleanPath = file.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            const msgUint8 = new TextEncoder().encode(cleanPath);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
            const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

            let oshash = null; let phash = null;
            if (file.fingerprints) {
              const osFp = file.fingerprints.find(f => f.type === 'oshash'); if (osFp) oshash = osFp.value;
              const pFp = file.fingerprints.find(f => f.type === 'phash'); if (pFp) phash = pFp.value;
            } else { oshash = this.getOsHash(file); }

            const meta = {
              id: s.id, title: s.title || 'Unknown Video', code: s.code || '', studio: s.studio?.name || '',
              path: file.path, size: file.size, mod_time: file.mod_time, duration: file.duration, oshash: oshash, PHash: phash
            };

            hashMap['vsm_hash_' + hashHex] = meta;
            if (oshash) hashMap['vsm_os_' + oshash] = meta;
          }
        }

        const keys = await this.idbKeys();
        let migratedCount = 0; let matchedCount = 0;

        for (const key of keys) {
          const matchedMeta = hashMap[key];
          if (matchedMeta) {
            const raw = await this.idbGet(key);
            if (raw) {
              const data = JSON.parse(raw);
              data.sceneMetadata = matchedMeta; // Silently update meta, don't flag as dirty

              if (key.startsWith('vsm_hash_') && matchedMeta.oshash) {
                const newOsKey = 'vsm_os_' + matchedMeta.oshash;
                await this.idbSet(newOsKey, JSON.stringify(data));
                await this.idbRemove(key);
                migratedCount++; matchedCount++;
              } else {
                await this.idbSet(key, JSON.stringify(data));
                matchedCount++;
              }
            }
          }
        }

        const execTimeMs = (performance.now() - startTime).toFixed(2);
        window.VSM.Log.info('Scraper', `Scrape Complete in ${execTimeMs}ms. Mapped ${matchedCount} items. Upgraded ${migratedCount} to OSHash.`, { matchedCount, migratedCount });
        return matchedCount;
      } catch (e) {
        window.VSM.Log.error('Scraper', 'Fatal GraphQL error during scrape.', e);
        throw e;
      }
    }

    get supabaseHeaders() {
      return {
        'Content-Type': 'application/json',
        'apikey': this.settings.supabaseKey,
        'Authorization': `Bearer ${this.settings.supabaseKey}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      };
    }

    // ==========================================
    // THE 3-WAY GIT ENGINE (Push & Pull)
    // ==========================================
    async fetchCloudManifest() {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return null;
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `${this.settings.supabaseUrl}/rest/v1/vsm_sync_data?select=key,last_updated&limit=5000`,
          headers: this.supabaseHeaders,
          onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve(null); } },
          onerror: () => resolve(null)
        });
      });
    }

    async getPushQueue() {
      const raw = await this.idbGet('vsm_push_queue');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    }

    async savePushQueue(queueSet) {
      await this.idbSet('vsm_push_queue', JSON.stringify(Array.from(queueSet)));
    }

    async executeSmartPush() {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return;

      const queue = await this.getPushQueue();
      if (queue.size === 0) return;

      window.VSM.Log.info('Sync', `Executing Smart Bulk Push for ${queue.size} records from persistent queue.`);

      const toPush = [];
      const processedKeys = [];

      for (const key of queue) {
        const raw = await this.idbGet(key);
        if (raw) {
          const data = JSON.parse(raw);
          const optPayload = JSON.parse(JSON.stringify(data));

          if (optPayload.timeThumbs) {
            for (const [k, v] of Object.entries(optPayload.timeThumbs)) {
              if (v?.startsWith('data:image/')) delete optPayload.timeThumbs[k];
            }
          }
          toPush.push({ key, payload: optPayload, last_updated: data.lastUpdated || Date.now() });
          processedKeys.push(key);
        } else {
          processedKeys.push(key);
        }
      }

      if (toPush.length === 0) {
        // THE FIX: Use atomic removal instead of nuking the entire queue array!
        await this.idbAtomicQueueRemove('vsm_push_queue', processedKeys);
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: `${this.settings.supabaseUrl}/rest/v1/vsm_sync_data?on_conflict=key`,
        headers: { ...this.supabaseHeaders, 'Prefer': 'resolution=merge-duplicates' },
        data: JSON.stringify(toPush),
        onload: async (r) => {
          if (r.status >= 200 && r.status < 300) {
            window.VSM.Log.info('Sync', `Smart Bulk Push Complete. Successfully uploaded ${toPush.length} records.`);

            await this.idbAtomicQueueRemove('vsm_push_queue', processedKeys);

            for (const item of toPush) {
              const raw = await this.idbGet(item.key);
              if (raw) {
                const data = JSON.parse(raw);
                data.baseCloudTs = item.last_updated;
                await this.idbSet(item.key, JSON.stringify(data));
                if (item.key === 'vsm_global_settings') this.settings.baseCloudTs = item.last_updated;
              }
            }
          } else {
            window.VSM.Log.error('Sync', 'Smart Bulk Push Failed. Items remain in queue for next retry.', r.responseText);
          }
        },
        onerror: (err) => window.VSM.Log.error('Sync', 'Network error during push. Items remain in queue for next retry.', err)
      });
    }

    async executeSmartPull() {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return;
      window.VSM.Log.info('Git', 'Initiating Git-Style Pull (Diffing cloud manifest against local...)');

      const manifest = await this.fetchCloudManifest();
      if (!manifest) return;

      const toPull = [];
      for (const row of manifest) {
        const localRaw = await this.idbGet(row.key);
        const localData = localRaw ? JSON.parse(localRaw) : null;

        const cloudTs = row.last_updated;
        const localTs = localData ? (localData.lastUpdated || 0) : 0;
        const baseTs = localData ? (localData.baseCloudTs || 0) : 0;

        // If cloud has newer data than our ancestor base...
        if (cloudTs > baseTs) {
          // If we have unsynced local edits, it's a conflict! Leave it for the Push engine to merge.
          if (localTs > baseTs) {
            window.VSM.Log.debug('Git', `Skipping pull for ${row.key} (Local edits exist. Will merge on Push).`);
            continue;
          }
          // Fast-Forward Pull
          toPull.push(row.key);
        }
      }

      if (toPull.length === 0) {
        window.VSM.Log.debug('Git', 'Local is fully up to date. Nothing to pull.');
        return;
      }

      window.VSM.Log.info('Git', `Downloading ${toPull.length} newer records from the cloud...`);

      for (let i = 0; i < toPull.length; i += 50) {
        const batchKeys = toPull.slice(i, i + 50);
        const keyQuery = batchKeys.map(encodeURIComponent).join(',');

        await new Promise(resolveChunk => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: `${this.settings.supabaseUrl}/rest/v1/vsm_sync_data?key=in.(${keyQuery})&select=*`,
            headers: this.supabaseHeaders,
            onload: async (chunkRes) => {
              try {
                const rows = JSON.parse(chunkRes.responseText) || [];
                for (const row of rows) {
                  const cloudPayload = row.payload;

                  const existingRaw = await this.idbGet(row.key);
                  if (existingRaw) {
                    const existing = JSON.parse(existingRaw);
                    if (existing.timeThumbs) {
                      cloudPayload.timeThumbs = cloudPayload.timeThumbs || {};
                      for (const k in existing.timeThumbs) {
                        if (existing.timeThumbs[k]?.startsWith('data:image/') && !cloudPayload.timeThumbs[k]) {
                          cloudPayload.timeThumbs[k] = existing.timeThumbs[k];
                        }
                      }
                    }
                  }

                  // Fast Forward local tracking timestamps
                  cloudPayload.lastUpdated = row.last_updated;
                  cloudPayload.baseCloudTs = row.last_updated;

                  await this.idbSet(row.key, JSON.stringify(cloudPayload));

                  if (row.key === this.currentSceneKey) {
                    this.syncChannel.postMessage({ action: 'reload_scene', key: row.key });
                    await this.loadSceneData();
                    if (this.app.ui) this.app.ui.refreshAll();
                  } else if (row.key === 'vsm_global_settings') {
                    this.settings = { ...this.DEFAULT_SETTINGS, ...cloudPayload };
                    this.settings.useSupabase = this.DEFAULT_SETTINGS.useSupabase;
                    this.settings.supabaseUrl = this.DEFAULT_SETTINGS.supabaseUrl;
                    this.settings.supabaseKey = this.DEFAULT_SETTINGS.supabaseKey;
                    this.startPullTimer();
                    if (this.app.ui) this.app.ui.refreshAll();
                  }
                }
              } catch (e) { }
              resolveChunk();
            }
          });
        });
      }
      window.VSM.Log.info('Git', 'Smart Pull complete!');
    }

    async performDeepMerge(key, localData) {
      return new Promise(resolve => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `${this.settings.supabaseUrl}/rest/v1/vsm_sync_data?key=eq.${encodeURIComponent(key)}&select=*`,
          headers: this.supabaseHeaders,
          onload: async (r) => {
            try {
              const d = JSON.parse(r.responseText);
              if (!d || !d.length) return resolve(localData); // Fallback

              const cloudRow = d[0];
              const cloudData = cloudRow.payload;

              window.VSM.Log.debug('Git', `Performing deep 3-way merge on ${key}...`);

              if (key === 'vsm_global_settings') {
                // For settings, cloud takes precedence to avoid erratic UI state merging
                const mergedSettings = { ...localData, ...cloudData };
                mergedSettings.lastUpdated = Date.now();
                mergedSettings.baseCloudTs = mergedSettings.lastUpdated; // Commit
                await this.idbSet(key, JSON.stringify(mergedSettings));
                this.settings = mergedSettings;
                return resolve(mergedSettings);
              }

              const merged = { ...cloudData, ...localData }; // Local base wins primitives

              // MERGE ARRAYS (Loop Points)
              const lSet = new Set(localData.loopPoints || []);
              const cSet = new Set(cloudData.loopPoints || []);
              const union = new Set([...lSet, ...cSet]);
              merged.loopPoints = Array.from(union).sort((a, b) => a - b);

              // MERGE OBJECTS (Thumbnails)
              merged.timeThumbs = { ...(cloudData.timeThumbs || {}), ...(localData.timeThumbs || {}) };

              // REBUILD META (Best effort mapping by index, local wins labels/bookmarks, loop counts sum)
              const mergedMeta = [];
              const numRegions = Math.floor(merged.loopPoints.length / 2);
              for (let i = 0; i < numRegions; i++) {
                const lm = localData.regionMeta?.[i] || { bookmark: false, label: '', loopCount: 0 };
                const cm = cloudData.regionMeta?.[i] || { bookmark: false, label: '', loopCount: 0 };
                mergedMeta.push({
                  bookmark: lm.bookmark || cm.bookmark,
                  label: lm.label || cm.label,
                  loopCount: (lm.loopCount || 0) + (cm.loopCount || 0)
                });
              }
              merged.regionMeta = mergedMeta;

              // MERGE SCENE META
              merged.sceneMetadata = { ...(cloudData.sceneMetadata || {}), ...(localData.sceneMetadata || {}) };

              // Finalize Merge Commit
              merged.lastUpdated = Date.now();
              merged.baseCloudTs = merged.lastUpdated; // Rebase to new commit

              await this.idbSet(key, JSON.stringify(merged));
              resolve(merged);
            } catch (e) {
              resolve(localData);
            }
          }
        });
      });
    }

    preparePayload(key, data) {
      const opt = JSON.parse(JSON.stringify(data));
      if (opt.timeThumbs) {
        for (const [k, v] of Object.entries(opt.timeThumbs)) {
          if (v?.startsWith('data:image/')) delete opt.timeThumbs[k];
        }
      }
      return { key, payload: opt, last_updated: data.lastUpdated };
    }

    async queueSmartPush(key) {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return;
      if (key) {
        await this.idbAtomicQueueAdd('vsm_push_queue', key);
        window.VSM.Log.debug('Sync', `[${key.substring(0, 15)}...] added to persistent push queue.`);
      }

      if (this.pushDebounceTimer) clearTimeout(this.pushDebounceTimer);

      let delayMs = (this.settings.autoPushDelay || 8) * (this.settings.autoPushUnit || 1000);
      delayMs = Math.max(0, delayMs);

      window.VSM.Log.debug('Git', `Queueing Smart Push in ${delayMs / 1000}s...`);

      this.pushDebounceTimer = setTimeout(() => {
        this.executeSmartPush().catch(e => window.VSM.Log.error('Git', 'Push error', e));
      }, delayMs);
    }

    startPullTimer() {
      if (this.pullIntervalTimer) clearInterval(this.pullIntervalTimer);
      let delayMs = (this.settings.syncPullInterval || 0) * (this.settings.syncPullUnit || 60000);
      delayMs = Math.max(0, delayMs); // Clamp
      if (delayMs > 0) {
        this.pullIntervalTimer = setInterval(() => this.executeSmartPull(), delayMs);
        window.VSM.Log.info('Git', `Auto-Pull CRON active. Polling every ${delayMs / 60000} minutes.`);
      } else {
        window.VSM.Log.info('Git', `Auto-Pull CRON Disabled. Manual sync only.`);
      }
    }

    async uploadThumbnailToStorage(base64Data, timeKey, sceneKeyOverride = null) {
      if (!this.settings.useSupabase || !this.settings.supabaseKey || !base64Data?.startsWith('data:image/')) return base64Data;
      try {
        const parts = base64Data.split(','); const byteString = atob(parts[1]); const mimeString = parts[0].split(':')[1].split(';')[0];
        const ab = new ArrayBuffer(byteString.length); const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
        const blob = new Blob([ab], { type: mimeString });
        const sceneKey = sceneKeyOverride || this.currentSceneKey;
        if (!sceneKey) return base64Data;
        const filename = `${sceneKey}_${timeKey}.jpg`;

        return new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: `${this.settings.supabaseUrl}/storage/v1/object/vsm_thumbs/${filename}`,
            headers: { 'Authorization': `Bearer ${this.settings.supabaseKey}`, 'apikey': this.settings.supabaseKey, 'Content-Type': mimeString, 'x-upsert': 'true' },
            data: blob,
            onload: (res) => {
              if (res.status >= 200 && res.status < 300) resolve(`${this.settings.supabaseUrl}/storage/v1/object/public/vsm_thumbs/${filename}`);
              else resolve(base64Data);
            },
            onerror: () => resolve(base64Data)
          });
        });
      } catch (e) { return base64Data; }
    }

    async autoMigrateThumbsToStorage() {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return;
      const keys = await this.idbKeys();
      for (const key of keys) {
        if (!key.startsWith('vsm_hash_') && !key.startsWith('vsm_os_')) continue;
        try {
          const raw = await this.idbGet(key);
          if (!raw) continue;
          let sData = JSON.parse(raw);
          let updated = false;
          for (const [timeKey, thumbData] of Object.entries(sData.timeThumbs || {})) {
            if (thumbData?.startsWith('data:image/')) {
              const pUrl = await this.uploadThumbnailToStorage(thumbData, timeKey, key);
              if (pUrl && pUrl !== thumbData) { sData.timeThumbs[timeKey] = pUrl; updated = true; await new Promise(r => setTimeout(r, 300)); }
            }
          }
          if (updated) {
            sData.lastUpdated = Date.now();
            await this.idbSet(key, JSON.stringify(sData));
            this.queueSmartPush(key);
          }
        } catch (e) { }
      }
    }

    async init() {
      await this.getDB();
      await this.loadGlobalSettings();

      this.startPullTimer();
      setTimeout(() => this.autoMigrateThumbsToStorage(), 5000);

      // Flush any leftover queue items from a previous session crash/tab close
      setTimeout(() => this.executeSmartPush(), 3000);

      // JIT Background Scrape
      setTimeout(() => {
        this.scrapeAllStashMetadata().then(() => {
          const modal = document.getElementById('vsm-dashboard-modal');
          if (modal && modal.classList.contains('active')) this.app.ui.openDashboard();
        }).catch(() => { });
      }, 7000);
    }

    async loadGlobalSettings() {
      let localSettings = null;
      try { const lStr = await this.idbGet("vsm_global_settings"); if (lStr) localSettings = JSON.parse(lStr); } catch (e) { }

      if (localSettings) {
        this.settings = { ...this.DEFAULT_SETTINGS, ...localSettings, customShortcuts: { ...this.DEFAULT_SETTINGS.customShortcuts, ...(localSettings.customShortcuts || {}) } };
      }

      this.settings.useSupabase = this.DEFAULT_SETTINGS.useSupabase;
      this.settings.supabaseUrl = this.DEFAULT_SETTINGS.supabaseUrl;
      this.settings.supabaseKey = this.DEFAULT_SETTINGS.supabaseKey;

      if (this.settings.navBookmarksOnly === undefined) this.settings.navBookmarksOnly = false;
      if (this.settings.syncPullInterval === undefined) this.settings.syncPullInterval = this.DEFAULT_SETTINGS.syncPullInterval;
      if (this.settings.syncPullUnit === undefined) this.settings.syncPullUnit = this.DEFAULT_SETTINGS.syncPullUnit;
      if (this.settings.autoPushDelay === undefined) this.settings.autoPushDelay = this.DEFAULT_SETTINGS.autoPushDelay;
      if (this.settings.autoPushUnit === undefined) this.settings.autoPushUnit = this.DEFAULT_SETTINGS.autoPushUnit;
      if (this.settings.baseCloudTs === undefined) this.settings.baseCloudTs = 0;
    }

    async cloudPull(key) {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return null;
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `${this.settings.supabaseUrl}/rest/v1/vsm_sync_data?key=eq.${encodeURIComponent(key)}&select=key,last_updated,payload`,
          headers: this.supabaseHeaders,
          onload: (r) => {
            try {
              const data = JSON.parse(r.responseText);
              if (data && data.length > 0) resolve(data[0]);
              else resolve(null);
            } catch (e) {
              resolve(null);
            }
          },
          onerror: () => resolve(null)
        });
      });
    }

    cloudPush(key, payload, localTimestamp) {
      if (!this.settings.useSupabase || !this.settings.supabaseKey) return;

      let optPayload = JSON.parse(JSON.stringify(payload));

      if (optPayload.timeThumbs) {
        for (const [k, v] of Object.entries(optPayload.timeThumbs)) {
          if (v?.startsWith('data:image/')) delete optPayload.timeThumbs[k];
        }
      }

      const payloadSizeKb = (new Blob([JSON.stringify(optPayload)]).size / 1024).toFixed(2);
      window.VSM.Log.debug('Storage', `Adding to Push Queue [${key.substring(0, 15)}...]`, { sizeKb: payloadSizeKb, localTs: localTimestamp });

      // Add to the queue and tell the processor to start
      this.vsm_push_queue.push({ key, optPayload, localTimestamp });
      this.processPushQueue();
    }

    async processPushQueue() {
      // If the queue is already running, don't start a second loop
      if (this.isQueueProcessing) return;
      this.isQueueProcessing = true;

      while (this.vsm_push_queue.length > 0) {
        // Grab the oldest task in the line
        const task = this.vsm_push_queue.shift();

        // Wrap the entire sync and network request in a Promise so we can AWAIT it
        await new Promise(async (resolve) => {
          try {
            const cData = await this.cloudPull(task.key);
            let finalPayload = task.optPayload;
            let finalTimestamp = task.localTimestamp;

            if (cData && cData.last_updated > (this.lastSyncedCloudTimes[task.key] || 0)) {
              const timeDiffSec = ((cData.last_updated - task.localTimestamp) / 1000).toFixed(1);
              window.VSM.Log.warn('Sync', `Conflict! Cloud is ${timeDiffSec}s newer. Executing Silent Git-Rebase.`);

              if (task.key === 'vsm_global_settings') {
                const s = { ...this.DEFAULT_SETTINGS, ...cData.payload };
                s.useSupabase = this.DEFAULT_SETTINGS.useSupabase;
                s.supabaseUrl = this.DEFAULT_SETTINGS.supabaseUrl;
                s.supabaseKey = this.DEFAULT_SETTINGS.supabaseKey;
                s.lastUpdated = Date.now();

                this.settings = s;
                await this.idbSet("vsm_global_settings", JSON.stringify(this.settings));
                Object.assign(finalPayload, s);
                finalTimestamp = s.lastUpdated;
                if (this.app.ui) this.app.ui.refreshAll();
              } else {
                const cPayload = cData.payload;
                const mergedPayload = {
                  loopPoints: cPayload.loopPoints || [],
                  timeThumbs: { ...(finalPayload.timeThumbs || {}), ...(cPayload.timeThumbs || {}) },
                  regionZoomPan: cPayload.regionZoomPan || [],
                  regionMeta: cPayload.regionMeta || [],
                  sceneMetadata: { ...(cPayload.sceneMetadata || {}), ...(finalPayload.sceneMetadata || {}) },
                  lastUpdated: Date.now()
                };

                await this.idbSet(task.key, JSON.stringify(mergedPayload));
                if (this.settings.useStashDB && this.lib?.stash?.updatePluginConfig) {
                  await this.lib.stash.updatePluginConfig(task.key, mergedPayload);
                }

                if (task.key === this.currentSceneKey) {
                  this.app.engine.loopPoints = mergedPayload.loopPoints;
                  this.app.engine.timeThumbs = mergedPayload.timeThumbs;
                  this.app.engine.regionZoomPan = mergedPayload.regionZoomPan;
                  this.app.engine.regionMeta = mergedPayload.regionMeta;
                  this.app.engine.isLooping = mergedPayload.loopPoints.length >= 2;
                  if (this.app.ui) this.app.ui.refreshAll();
                }

                Object.assign(finalPayload, mergedPayload);
                finalTimestamp = mergedPayload.lastUpdated;
              }
            }

            GM_xmlhttpRequest({
              method: 'POST',
              url: `${this.settings.supabaseUrl}/rest/v1/vsm_sync_data?on_conflict=key`,
              headers: { ...this.supabaseHeaders, 'Prefer': 'resolution=merge-duplicates' },
              data: JSON.stringify({ key: task.key, payload: finalPayload, last_updated: finalTimestamp }),
              onload: (res) => {
                if (res.status >= 200 && res.status < 300) {
                  this.lastSyncedCloudTimes[task.key] = finalTimestamp;
                  window.VSM.Log.info('Cloud', `Push successful for [${task.key.substring(0, 15)}...]`);
                } else {
                  window.VSM.Log.error('Cloud', `Push failed. Supabase rejected the payload.`);
                }
                resolve(); // Network finished! Unlock the queue for the next item.
              },
              onerror: (err) => {
                window.VSM.Log.error('Cloud', `Network error during push.`, err);
                resolve(); // Unlock queue even on failure so it doesn't get permanently stuck
              }
            });
          } catch (e) {
            window.VSM.Log.error('Sync', `Critical failure during sync evaluation.`, e);
            resolve();
          }
        });
      }

      // Queue is empty, turn off the processing flag
      this.isQueueProcessing = false;
    }

    async loadSceneData() {
      this.app.engine.flushRAM();
      const sceneId = this.getSceneId(); if (!sceneId) return;

      this.currentSceneMetadata = await this.fetchSceneMetadata(sceneId);
      this.currentFilepath = this.currentSceneMetadata.path;

      const pathHashKey = await this.hashPath(this.currentFilepath);
      let targetKey = pathHashKey;

      if (this.currentSceneMetadata.oshash) {
        targetKey = 'vsm_os_' + this.currentSceneMetadata.oshash;

        const oldDataRaw = await this.idbGet(pathHashKey);
        const newDataRaw = await this.idbGet(targetKey);
        if (oldDataRaw && !newDataRaw) {
          window.VSM.Log.info('Storage', `JIT Migrating old path hash to universal OSHash key...`);
          const d = JSON.parse(oldDataRaw);

          d.sceneMetadata = this.currentSceneMetadata;

          await this.idbSet(targetKey, JSON.stringify(d));
          await this.idbRemove(pathHashKey);
        }
      }

      this.currentSceneKey = targetKey;
      window.VSM.Log.debug('Storage', `Active Database Key ->`, this.currentSceneKey);

      const localStr = await this.idbGet(this.currentSceneKey);
      let data = localStr ? JSON.parse(localStr) : null;

      if (data) {
        this.app.engine.loopPoints = data.loopPoints || [];
        this.app.engine.timeThumbs = data.timeThumbs || {};
        this.app.engine.regionZoomPan = data.regionZoomPan || [];
        this.app.engine.regionMeta = data.regionMeta || Array.from({ length: Math.floor(this.app.engine.loopPoints.length / 2) }, () => ({ bookmark: false, label: '', loopCount: 0 }));
        this.app.engine.isLooping = this.app.engine.loopPoints.length >= 2;
      }
    }

    async saveGlobalSettings(skipCloud = false) {
      if (!skipCloud) {
        this.settings.lastUpdated = Date.now();
      }
      const str = JSON.stringify(this.settings);
      await this.idbSet("vsm_global_settings", str);
      this.syncChannel.postMessage({ key: "vsm_global_settings", newValue: str });

      if (this.settings.useStashDB && this.lib?.stash?.updatePluginConfig) {
        await this.lib.stash.updatePluginConfig("vsm_global_settings", this.settings);
      }

      if (!skipCloud) {
        this.queueSmartPush("vsm_global_settings");
      }

      this.startPullTimer();
    }

    async saveSceneData(skipCloud = false) {
      if (!this.currentSceneKey) return;

      // 1. Snapshot the EXACT target key and RAM state immediately.
      // This prevents rapid page navigation from corrupting or deleting the data!
      const targetKey = this.currentSceneKey;
      const targetMetadata = JSON.parse(JSON.stringify(this.currentSceneMetadata || {}));

      const activeKeys = new Set(this.app.engine.loopPoints.map(p => Math.round(p)));
      const timeThumbsClone = {};
      for (const k in this.app.engine.timeThumbs) {
        if (activeKeys.has(parseInt(k))) timeThumbsClone[k] = this.app.engine.timeThumbs[k];
      }

      const sceneDataSnapshot = {
        loopPoints: [...this.app.engine.loopPoints],
        timeThumbs: timeThumbsClone,
        regionZoomPan: JSON.parse(JSON.stringify(this.app.engine.regionZoomPan || [])),
        regionMeta: JSON.parse(JSON.stringify(this.app.engine.regionMeta || [])),
        sceneMetadata: targetMetadata
      };

      if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);

      this._saveDebounceTimer = setTimeout(async () => {
        sceneDataSnapshot.lastUpdated = Date.now();

        if (sceneDataSnapshot.loopPoints.length === 0) {
          await this.idbRemove(targetKey);
        } else {
          await this.idbSet(targetKey, JSON.stringify(sceneDataSnapshot));
          if (!skipCloud) this.queueSmartPush(targetKey);
        }
      }, 300);
    }
  };

  // ==========================================
  // 2. ENGINE MODULE
  // ==========================================
  window.VSM.Engine = class {
    constructor(app) {
      this.app = app;
      this.flushRAM();
      this.bindMethods();
      this.saveMetaTimer = null;
    }

    flushRAM() {
      this.loopPoints = [];
      this.timeThumbs = {};
      this.regionZoomPan = [];
      this.regionMeta = [];
      this.isLooping = false;
      this.currentRegionIdx = -1;
      this.isSnapping = false;
      this.lastManualSeekTime = 0;
      this.zoomLevel = 1.0;
      this.panX = 0;
      this.panY = 0;
      if (typeof this.resetZoom === 'function') this.resetZoom();
    }

    bindMethods() {
      this.handleTimeUpdate = this.handleTimeUpdate.bind(this);
      this.applyVideoTransform = this.applyVideoTransform.bind(this);
    }

    getCurrentRegionIdx() {
      if (!this.app.player || this.loopPoints.length < 2) return -1;
      const curr = this.app.player.currentTime();
      for (let r = 0; r < Math.floor(this.loopPoints.length / 2); r++) {
        if (curr >= this.loopPoints[r * 2] && curr < this.loopPoints[r * 2 + 1]) return r;
      }
      return -1;
    }

    handleTimeUpdate() {
      if (!this.app.player || !this.isLooping || this.loopPoints.length < 2 || this.isSnapping) return;
      if (Date.now() - this.lastManualSeekTime < 500) return;

      const curr = this.app.player.currentTime();

      if (this.currentRegionIdx !== -1) {
        const end = this.loopPoints[this.currentRegionIdx * 2 + 1];
        const start = this.loopPoints[this.currentRegionIdx * 2];

        if (curr >= end && curr < end + 1.0) {
          this.isSnapping = true;
          this.lastManualSeekTime = Date.now();
          this.app.player.currentTime(start);

          if (!this.regionMeta[this.currentRegionIdx]) this.regionMeta[this.currentRegionIdx] = { bookmark: false, label: '', loopCount: 0 };
          this.regionMeta[this.currentRegionIdx].loopCount = (this.regionMeta[this.currentRegionIdx].loopCount || 0) + 1;

          if (this.saveMetaTimer) clearTimeout(this.saveMetaTimer);
          this.saveMetaTimer = setTimeout(() => this.app.storage.saveSceneData(), 2000);

          this.app.ui.updateOverlayButtons();
          setTimeout(() => { this.isSnapping = false; }, 250);
          return;
        }
      }

      const newIdx = this.getCurrentRegionIdx();
      if (newIdx !== this.currentRegionIdx) {
        this.currentRegionIdx = newIdx;
        this.loadRegionView(newIdx);
        this.app.ui.updateActiveRegionHighlight();
      }
    }

    manualSeekTo(time, forceRegionIdx = null) {
      if (!this.app.player) return;
      this.lastManualSeekTime = Date.now();
      this.app.player.currentTime(time);
      const targetIdx = forceRegionIdx !== null ? forceRegionIdx : this.getCurrentRegionIdx();
      if (targetIdx !== this.currentRegionIdx) {
        this.currentRegionIdx = targetIdx;
        this.loadRegionView(targetIdx);
        if (this.app.ui) this.app.ui.updateActiveRegionHighlight();
      }
    }

    addPoint() {
      if (!this.app.player) return;
      const time = this.app.player.currentTime();
      if (this.loopPoints.some(p => Math.abs(p - time) < 0.1)) return;

      const timeKey = Math.round(time);
      const thumb = this.captureVideoFrame();
      if (thumb) {
        this.timeThumbs[timeKey] = thumb;
        this.app.storage.uploadThumbnailToStorage(thumb, timeKey).then(url => {
          if (url !== thumb) { this.timeThumbs[timeKey] = url; this.app.storage.saveSceneData(); }
        });
      }

      this.loopPoints.push(time);
      this.loopPoints.sort((a, b) => a - b);

      const newNumRegions = Math.floor(this.loopPoints.length / 2);
      while (this.regionMeta.length < newNumRegions) this.regionMeta.push({ bookmark: false, label: '', loopCount: 0 });

      if (this.loopPoints.length === 2 && !this.isLooping) this.isLooping = true;
      this.app.ui.refreshAll();
      this.app.storage.saveSceneData();
    }

    deleteRegion(regionIdx) {
      const i = regionIdx * 2;
      delete this.timeThumbs[Math.round(this.loopPoints[i])];
      delete this.timeThumbs[Math.round(this.loopPoints[i + 1])];
      this.loopPoints.splice(i, 2);
      this.regionZoomPan.splice(regionIdx, 1);
      this.regionMeta.splice(regionIdx, 1);

      if (this.currentRegionIdx === regionIdx) { this.currentRegionIdx = -1; this.resetZoom(); }
      else if (this.currentRegionIdx > regionIdx) { this.currentRegionIdx--; }

      if (this.loopPoints.length < 2) this.isLooping = false;
      this.app.ui.refreshAll();
      this.app.storage.saveSceneData();
    }

    splitCurrentRegion() {
      const r = this.getCurrentRegionIdx();
      if (r < 0) return;
      const curr = this.app.player.currentTime();
      const start = this.loopPoints[r * 2];
      const end = this.loopPoints[r * 2 + 1];

      if (curr - start < 0.1 || end - curr < 0.1) return;
      const splitTime = parseFloat(curr.toFixed(2));
      const timeKey = Math.round(splitTime);

      const thumb = this.captureVideoFrame();
      if (thumb) {
        this.timeThumbs[timeKey] = thumb;
        this.app.storage.uploadThumbnailToStorage(thumb, timeKey).then(url => {
          if (url !== thumb) { this.timeThumbs[timeKey] = url; this.app.storage.saveSceneData(); }
        });
      }

      this.loopPoints.splice(r * 2 + 1, 1, splitTime, splitTime, end);
      const copyZ = this.regionZoomPan[r] ? { ...this.regionZoomPan[r] } : { zoom: 1, panX: 0, panY: 0 };
      this.regionZoomPan.splice(r + 1, 0, copyZ);

      const copyM = this.regionMeta[r] ? { ...this.regionMeta[r], loopCount: 0 } : { bookmark: false, label: '', loopCount: 0 };
      this.regionMeta.splice(r + 1, 0, copyM);

      this.currentRegionIdx = -1;
      this.app.ui.refreshAll();
      this.app.storage.saveSceneData();
    }

    mergeRegions(idx1, idx2) {
      if (idx1 < 0 || idx2 >= Math.floor(this.loopPoints.length / 2)) return;
      const i1 = idx1 * 2; const i2 = idx2 * 2;

      delete this.timeThumbs[Math.round(this.loopPoints[i1 + 1])];
      delete this.timeThumbs[Math.round(this.loopPoints[i2])];

      this.loopPoints.splice(i1 + 1, 2);
      this.regionZoomPan.splice(idx2, 1);

      if (this.regionMeta[idx1] && this.regionMeta[idx2]) {
        this.regionMeta[idx1].loopCount += (this.regionMeta[idx2].loopCount || 0);
      }
      this.regionMeta.splice(idx2, 1);

      if (this.currentRegionIdx === idx2) this.currentRegionIdx = idx1;
      else if (this.currentRegionIdx > idx2) this.currentRegionIdx--;

      this.app.ui.refreshAll();
      this.app.storage.saveSceneData();
    }

    navigateRegion(dir) {
      if (!this.app.player || this.loopPoints.length < 2) return;
      const numRegions = Math.floor(this.loopPoints.length / 2);
      let currentRegion = this.getCurrentRegionIdx();
      let targetRegion = currentRegion + dir;

      if (this.app.storage.settings.navBookmarksOnly) {
        let found = false;
        while (targetRegion >= 0 && targetRegion < numRegions) {
          if (this.regionMeta[targetRegion] && this.regionMeta[targetRegion].bookmark) { found = true; break; }
          targetRegion += dir;
        }
        if (!found) return;
      } else {
        if (currentRegion === -1) targetRegion = dir > 0 ? 0 : numRegions - 1;
        if (targetRegion < 0) targetRegion = 0;
        if (targetRegion >= numRegions) targetRegion = numRegions - 1;
      }

      this.manualSeekTo(this.loopPoints[targetRegion * 2], targetRegion);
      this.app.ui.updateOverlayButtons();
    }

    adjustRegionBound(regionIdx, boundType, delta) {
      if (!this.app.player) return;
      const i = regionIdx * 2;
      const isStart = boundType === 'start';
      const oldTime = this.loopPoints[isStart ? i : i + 1];

      let newTime;
      if (isStart) {
        newTime = Math.max(0, parseFloat((this.loopPoints[i] + delta).toFixed(2)));
        if (newTime >= this.loopPoints[i + 1] - 0.1) return;
        if (i > 0 && newTime <= this.loopPoints[i - 1]) {
          const prevStart = this.loopPoints[i - 2];
          if (newTime <= prevStart + 0.1) newTime = prevStart + 0.1;
          const oldPrevEnd = this.loopPoints[i - 1];
          this.loopPoints[i - 1] = newTime;
          delete this.timeThumbs[Math.round(oldPrevEnd)];
        }
        this.loopPoints[i] = newTime;
      } else {
        const dur = this.app.player.duration() || Infinity;
        newTime = Math.min(dur, parseFloat((this.loopPoints[i + 1] + delta).toFixed(2)));
        if (newTime <= this.loopPoints[i] + 0.1) return;
        if (i + 2 < this.loopPoints.length && newTime >= this.loopPoints[i + 2]) {
          const nextEnd = this.loopPoints[i + 3];
          if (newTime >= nextEnd - 0.1) newTime = nextEnd - 0.1;
          const oldNextStart = this.loopPoints[i + 2];
          this.loopPoints[i + 2] = newTime;
          delete this.timeThumbs[Math.round(oldNextStart)];
        }
        this.loopPoints[i + 1] = newTime;
      }

      if (Math.round(oldTime) !== Math.round(newTime)) delete this.timeThumbs[Math.round(oldTime)];
      this.app.ui.refreshAll();
      this.app.storage.saveSceneData();
      this.updateThumbnailForTime(newTime, regionIdx);
    }

    updateThumbnailForTime(time, forceRegionIdx = null) {
      if (!this.app.player) return;
      if (this._captureTimer) clearTimeout(this._captureTimer);
      if (this._captureHandler) this.app.player.off('seeked', this._captureHandler);

      this.manualSeekTo(time, forceRegionIdx);

      this._captureHandler = () => {
        this._captureHandler = null;
        const thumb = this.captureVideoFrame();
        if (thumb) {
          const timeKey = Math.round(time);
          this.timeThumbs[timeKey] = thumb;
          this.app.ui.updateOverlayButtons();
          this.app.storage.saveSceneData();
          this.app.storage.uploadThumbnailToStorage(thumb, timeKey).then(url => {
            if (url !== thumb) { this.timeThumbs[timeKey] = url; this.app.ui.updateOverlayButtons(); this.app.storage.saveSceneData(); }
          });
        }
      };

      if (this.app.player.seeking()) this.app.player.one('seeked', this._captureHandler);
      else this._captureTimer = setTimeout(this._captureHandler, 150);
    }

    captureVideoFrame() {
      if (!this.app.player) return null;
      const videoEl = this.app.player.el().querySelector('video');
      if (!videoEl || videoEl.readyState < 2) return null;
      try {
        const canvas = document.createElement('canvas');
        const targetWidth = 480;
        const vW = videoEl.videoWidth || 1920;
        const vH = videoEl.videoHeight || 1080;
        canvas.width = targetWidth; canvas.height = Math.round(targetWidth * (vH / vW));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const dataURL = canvas.toDataURL('image/jpeg', 0.92);
        canvas.width = 0; canvas.height = 0;
        return dataURL;
      } catch (e) { return null; }
    }

    setupZoomPan() {
      if (!this.app.player) return;
      if (this.zoomPanCleanup) { this.zoomPanCleanup(); }

      const playerEl = this.app.player.el();

      const onWheel = (e) => {
        if (e.target.closest('.vsm-overlay-container, #videoShortcutPopup, #vsm-dashboard-modal')) return;
        if (this.currentRegionIdx < 0) return;
        e.preventDefault();

        const zoomSense = this.app.storage.settings.zoomSensitivity || 0.15;
        const zoomDelta = e.deltaY < 0 ? zoomSense : -zoomSense;
        const newZoom = Math.max(1, Math.min(5, this.zoomLevel + zoomDelta));
        if (newZoom === this.zoomLevel) return;

        const rect = playerEl.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const ratio = newZoom / this.zoomLevel;

        this.panX = mx * (1 - ratio) + this.panX * ratio;
        this.panY = my * (1 - ratio) + this.panY * ratio;
        this.zoomLevel = newZoom;
        if (this.zoomLevel <= 1) { this.panX = 0; this.panY = 0; }

        this.clampPan(false);
        this.applyVideoTransform(false);

        if (this.wheelSnapTimer) clearTimeout(this.wheelSnapTimer);
        this.wheelSnapTimer = setTimeout(() => {
          if (!this.isDraggingZoom && this.zoomLevel > 1) {
            this.clampPan(true);
            this.applyVideoTransform(true);
            this.saveCurrentRegionView();
          }
        }, 250);
      };

      const onMouseDown = (e) => {
        if (this.zoomLevel <= 1 || e.button !== 0 || this.currentRegionIdx < 0) return;
        if (e.target.closest('.vjs-control-bar, .vsm-overlay-container, .vjs-progress-control, #videoShortcutPopup, #vsm-dashboard-modal')) return;

        this.isDraggingZoom = true;
        this.dragMoved = false;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartPanX = this.panX;
        this.dragStartPanY = this.panY;
        this.applyVideoTransform(false);
      };

      const onMouseMove = (e) => {
        if (!this.isDraggingZoom) return;
        const panSense = this.app.storage.settings.panSensitivity || 1.0;
        const dx = (e.clientX - this.dragStartX) * panSense;
        const dy = (e.clientY - this.dragStartY) * panSense;

        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.dragMoved = true;
        this.panX = this.dragStartPanX + dx;
        this.panY = this.dragStartPanY + dy;

        this.clampPan(false);
        this.applyVideoTransform(false);
      };

      const onMouseUp = () => {
        if (this.isDraggingZoom) {
          this.isDraggingZoom = false;
          if (this.dragMoved) {
            this.clampPan(true);
            this.applyVideoTransform(true);
            this.saveCurrentRegionView();
          }
        }
      };

      const onClick = (e) => { if (this.dragMoved) { e.preventDefault(); e.stopPropagation(); this.dragMoved = false; } };

      const onDblClick = (e) => {
        if (e.target.closest('.vjs-control-bar, .vsm-overlay-container, .vjs-progress-control, #videoShortcutPopup, #vsm-dashboard-modal') || this.zoomLevel <= 1) return;
        e.stopPropagation();
        this.zoomLevel = 1; this.panX = 0; this.panY = 0;
        this.applyVideoTransform(true);
        this.saveCurrentRegionView();
      };

      playerEl.addEventListener('wheel', onWheel, { passive: false });
      playerEl.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      playerEl.addEventListener('click', onClick, true);
      playerEl.addEventListener('dblclick', onDblClick);

      this.zoomPanCleanup = () => {
        playerEl.removeEventListener('wheel', onWheel);
        playerEl.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        playerEl.removeEventListener('click', onClick, true);
        playerEl.removeEventListener('dblclick', onDblClick);
      };

      this.startVideoStyleGuard();
    }

    clampPan(applySnapping = false) {
      if (!this.app.player || this.zoomLevel <= 1) { this.panX = 0; this.panY = 0; return; }
      const playerEl = this.app.player.el();
      const videoEl = playerEl.querySelector('video');

      const cW = playerEl.clientWidth; const cH = playerEl.clientHeight;
      const vW = videoEl.videoWidth || cW; const vH = videoEl.videoHeight || cH;

      const containerRatio = cW / cH; const videoRatio = vW / vH;
      let gapX = 0; let gapY = 0;

      if (videoRatio > containerRatio) { gapY = (cH - (cW / videoRatio)) / 2; }
      else if (videoRatio < containerRatio) { gapX = (cW - (cH * videoRatio)) / 2; }

      const physicalMaxPanX = cW / 2 * (this.zoomLevel - 1);
      const physicalMaxPanY = cH / 2 * (this.zoomLevel - 1);
      const trueMaxPanX = physicalMaxPanX - (gapX * this.zoomLevel);
      const trueMaxPanY = physicalMaxPanY - (gapY * this.zoomLevel);

      if (applySnapping) {
        const snapForceX = Math.max(80, physicalMaxPanX * 0.15);
        const snapForceY = Math.max(80, physicalMaxPanY * 0.15);
        if (trueMaxPanX > 0 && Math.abs(this.panX) < snapForceX) this.panX = 0;
        if (trueMaxPanY > 0) {
          if (Math.abs(this.panY - trueMaxPanY) < snapForceY) this.panY = trueMaxPanY;
          else if (Math.abs(this.panY - (-trueMaxPanY)) < snapForceY) this.panY = -trueMaxPanY;
        }
      }

      this.panX = Math.max(-physicalMaxPanX, Math.min(physicalMaxPanX, this.panX));
      this.panY = Math.max(-physicalMaxPanY, Math.min(physicalMaxPanY, this.panY));
    }

    saveCurrentRegionView() {
      if (this.currentRegionIdx < 0) return;
      this.regionZoomPan[this.currentRegionIdx] = { zoom: this.zoomLevel, panX: this.panX, panY: this.panY };
      if (this.saveZoomTimer) clearTimeout(this.saveZoomTimer);
      this.saveZoomTimer = setTimeout(() => { this.app.storage.saveSceneData(); this.saveZoomTimer = null; }, 400);
    }

    startVideoStyleGuard() {
      if (!this.app.player) return;
      if (this.videoStyleObserver) { this.videoStyleObserver.disconnect(); }
      const videoEl = this.app.player.el().querySelector('video');
      if (!videoEl) return;

      this.videoStyleObserver = new MutationObserver(() => {
        if (this.zoomLevel <= 1) return;
        const expectedLeft = `calc(${(1 - this.zoomLevel) * 50}% + ${this.panX}px)`;
        if (videoEl.style.left !== expectedLeft) this.applyVideoTransform(false);
      });
      this.videoStyleObserver.observe(videoEl, { attributes: true, attributeFilter: ['style'] });
    }

    resetZoom() {
      this.zoomLevel = 1; this.panX = 0; this.panY = 0;
      this.applyVideoTransform(true);
    }

    loadRegionView(idx) {
      if (idx >= 0 && this.regionZoomPan[idx]) {
        const zp = this.regionZoomPan[idx];
        this.zoomLevel = zp.zoom || 1; this.panX = zp.panX || 0; this.panY = zp.panY || 0;
      } else {
        this.zoomLevel = 1; this.panX = 0; this.panY = 0;
      }
      this.clampPan(false); this.applyVideoTransform(false);
    }

    applyVideoTransform(animate = false) {
      if (!this.app.player) return;
      const videoEl = this.app.player.el().querySelector('video');
      let badge = this.app.player.el().querySelector('.vsm-zoom-badge');

      if (this.zoomLevel <= 1.0) {
        if (videoEl) {
          videoEl.style.transition = animate ? 'all 0.3s cubic-bezier(0.25, 1, 0.5, 1)' : 'none';
          videoEl.style.width = '100%'; videoEl.style.height = '100%'; videoEl.style.left = '0px'; videoEl.style.top = '0px';
          videoEl.style.transform = ''; videoEl.style.cursor = '';
        }
        if (badge) badge.style.display = 'none';
      } else {
        if (videoEl) {
          videoEl.style.transition = animate ? 'all 0.3s cubic-bezier(0.25, 1, 0.5, 1)' : 'none';
          videoEl.style.width = `${this.zoomLevel * 100}%`; videoEl.style.height = `${this.zoomLevel * 100}%`;
          videoEl.style.left = `calc(${(1 - this.zoomLevel) * 50}% + ${this.panX}px)`; videoEl.style.top = `calc(${(1 - this.zoomLevel) * 50}% + ${this.panY}px)`;
          videoEl.style.transform = 'none'; videoEl.style.cursor = this.isDraggingZoom ? 'grabbing' : 'grab';
        }
        if (!badge) {
          badge = document.createElement('div'); badge.className = 'vsm-zoom-badge'; this.app.player.el().appendChild(badge);
        }
        badge.style.display = 'block'; badge.textContent = `${this.zoomLevel.toFixed(1)}×`;
      }
    }
  };

  // ==========================================
  // 3. UI MODULE (Overlay, Popup, Dashboard)
  // ==========================================
  window.VSM.UI = class {
    constructor(app) {
      this.app = app;
      this.REGION_COLORS = [
        { main: '#00d1b2', glow: 'rgba(0, 209, 178, 0.5)', bg: 'rgba(0, 209, 178, 0.1)' },
        { main: '#ffdd57', glow: 'rgba(255, 221, 87, 0.5)', bg: 'rgba(255, 221, 87, 0.1)' },
        { main: '#ff3860', glow: 'rgba(255, 56, 96, 0.5)', bg: 'rgba(255, 56, 96, 0.1)' }
      ];

      this.clickOutsideHandler = (e) => {
        const popup = document.getElementById('videoShortcutPopup');
        if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
          this.hidePopup();
        }
      };

      this.escHandler = (e) => {
        if (e.key === 'Escape') {
          const popup = document.getElementById('videoShortcutPopup');
          if (popup && popup.style.display !== 'none') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.hidePopup(); }

          const dashboard = document.getElementById('vsm-dashboard-modal');
          if (dashboard && dashboard.classList.contains('active')) { e.preventDefault(); e.stopPropagation(); dashboard.classList.remove('active'); }
        }
      };

      this.injectCSS();
      this.createPopup();
      this.createDashboard();
    }

    refreshAll() {
      this.updateUIVisibility();
      this.renderTimelineCheckpoints();
      this.updateOverlayButtons();
    }

    updateUIVisibility() {
      const s = this.app.storage.settings;
      document.querySelectorAll('.vjs-progress-control').forEach(el => el.style.display = s.hideUI?.progressBar ? 'none' : '');
      document.querySelectorAll('.vjs-control-bar').forEach(el => el.style.display = s.hideUI?.controlBar ? 'none' : '');
      const overlay = document.querySelector('.vsm-overlay-container');
      if (overlay) s.hideUI?.overlay ? overlay.classList.add('vsm-hidden') : overlay.classList.remove('vsm-hidden');
    }

    createOverlayUI() {
      if (!this.app.player) return;
      const playerEl = this.app.player.el();
      playerEl.querySelectorAll('.vsm-overlay-container').forEach(el => el.remove());

      const container = document.createElement('div');
      container.className = 'vsm-overlay-container';
      const step = this.app.storage.settings.microAdjustStep || 0.1;

      container.innerHTML = window.VSM.safeHTML(`
          <div class="vsm-header" style="align-items: center;">
            <span>REPLAY MGR <span style="font-size: 8px; opacity:0.6;">(V)</span></span>
            <div style="display:flex; align-items:center; gap:8px;">
                <button id="vsm-btn-dash" title="Open Master Dashboard" style="background:none; border:none; color:#00d1b2; cursor:pointer; font-size:12px;">📊</button>
                <span style="display:flex; align-items:center; gap:4px; font-size:8px;">
                  STEP:
                  <input type="number" id="vsm-overlay-step" value="${step}" step="0.05" title="Micro-adjust Step (Seconds)"
                         style="width:38px; background:rgba(0,0,0,0.6); color:#00d1b2; border:1px solid rgba(0,209,178,0.4); border-radius:3px; font-size:9px; text-align:center; outline:none; padding:1px;">
                </span>
            </div>
          </div>
          <div class="vsm-region-list-scroll"><div id="vsm-region-list"></div></div>
          <div class="vsm-controls"></div>
        `);

      container.querySelector('#vsm-btn-dash').addEventListener('click', (e) => { e.stopPropagation(); this.openDashboard(); });

      const stepInput = container.querySelector('#vsm-overlay-step');
      stepInput.addEventListener('change', async (e) => {
        let val = parseFloat(e.target.value); if (isNaN(val) || val <= 0) val = 0.1;
        this.app.storage.settings.microAdjustStep = val; await this.app.storage.saveGlobalSettings();
        this.updateOverlayButtons(); const popStep = document.getElementById('vsm-microStep'); if (popStep) popStep.value = val;
      });

      stepInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); stepInput.blur(); }
      }, true);

      container.querySelector('.vsm-region-list-scroll').addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

      const controls = container.querySelector('.vsm-controls');
      const createBtn = (txt, fn) => { const b = document.createElement('button'); b.className = 'vsm-overlay-btn'; b.innerHTML = window.VSM.safeHTML(txt); b.onclick = fn; controls.appendChild(b); return b; };
      createBtn('SET <kbd>C</kbd>', (e) => { e.stopPropagation(); this.app.engine.addPoint(); });
      const loopBtn = createBtn('LOOP <kbd>S</kbd>', async (e) => { e.stopPropagation(); this.app.engine.isLooping = !this.app.engine.isLooping; await this.app.storage.saveSceneData(); this.refreshAll(); });
      loopBtn.id = 'vsm-loop-toggle';
      createBtn('SPLT <kbd>D</kbd>', (e) => { e.stopPropagation(); this.app.engine.splitCurrentRegion(); });
      createBtn('CLR <kbd>B</kbd>', async (e) => { e.stopPropagation(); this.app.engine.loopPoints = []; this.app.engine.isLooping = false; await this.app.storage.saveSceneData(); this.refreshAll(); });

      playerEl.appendChild(container);
      this.updateOverlayButtons();
    }

    updateOverlayButtons() {
      const points = this.app.engine.loopPoints;
      const loopBtn = document.getElementById('vsm-loop-toggle');
      if (loopBtn) {
        this.app.engine.isLooping ? loopBtn.classList.add('vsm-active') : loopBtn.classList.remove('vsm-active');
        loopBtn.disabled = points.length < 2; loopBtn.style.opacity = points.length < 2 ? '0.3' : '1';
      }

      const list = document.getElementById('vsm-region-list');
      if (!list) return;
      list.innerHTML = window.VSM.safeHTML('');

      if (points.length < 2) {
        list.innerHTML = window.VSM.safeHTML(`<div style="font-size: 9px; color: #555;">Add points to start...</div>`);
        return;
      }

      const curr = this.app.player ? this.app.player.currentTime() : 0;
      let rowToScroll = null;
      const step = this.app.storage.settings.microAdjustStep;
      const numRegions = Math.floor(points.length / 2);

      while (this.app.engine.regionMeta.length < numRegions) this.app.engine.regionMeta.push({ bookmark: false, label: '', loopCount: 0 });

      for (let i = 0; i < points.length - 1; i += 2) {
        const regionIdx = i / 2;
        const colorObj = this.REGION_COLORS[regionIdx % this.REGION_COLORS.length];
        const start = points[i]; const end = points[i + 1];
        const isActive = curr >= start && curr < end;
        const meta = this.app.engine.regionMeta[regionIdx];

        const row = document.createElement('div');
        row.className = 'vsm-region-row' + (isActive ? ' vsm-active' : '');
        if (isActive) rowToScroll = row;

        row.onclick = async (e) => {
          if (e.target.closest('input') || e.target.closest('.vsm-bookmark-btn') || e.target.closest('.vsm-region-delete') || e.target.closest('.vsm-adjust-btn') || e.target.closest('.vsm-region-merge')) return;
          e.stopPropagation();
          this.app.engine.manualSeekTo(start, regionIdx);
          if (!this.app.engine.isLooping) { this.app.engine.isLooping = true; await this.app.storage.saveSceneData(); this.refreshAll(); }
        };

        const startThumb = this.app.engine.timeThumbs[Math.round(start)];
        const endThumb = this.app.engine.timeThumbs[Math.round(end)];
        const thumbCell = (url, label) => url ? `<div class="vsm-thumb-wrap"><img class="vsm-region-thumb" src="${url}" style="border:1.5px solid ${colorObj.main};"><span class="vsm-thumb-tag">${label}</span></div>` : `<div class="vsm-region-thumb-placeholder" style="border: 1.5px solid ${colorObj.main}55;">${label}</div>`;

        row.innerHTML = window.VSM.safeHTML(`
            ${numRegions > 1 ? `<button class="vsm-region-merge" title="Merge Region">M</button>` : ''}
            <button class="vsm-region-delete" title="Delete region">×</button>
            <div class="vsm-region-thumbs">${thumbCell(startThumb, this.formatTime(start))} ${thumbCell(endThumb, this.formatTime(end))}</div>
            <div class="vsm-region-meta">
              <span class="vsm-region-label"><span class="vsm-region-indicator" style="background:${colorObj.main}"></span>R${regionIdx + 1}</span>
              <span class="vsm-region-duration">${(end - start).toFixed(1)}s</span>
            </div>

            <div class="vsm-region-meta2" style="display:flex; align-items:center; gap:4px; margin-top:2px;">
                <button class="vsm-bookmark-btn ${meta.bookmark ? 'active' : ''}" title="Bookmark this region">${meta.bookmark ? '⭐' : '☆'}</button>
                <input type="text" class="vsm-label-input" value="${meta.label || ''}" placeholder="Label..." title="Add a label to this region">
                <span class="vsm-loop-count" title="Times Looped">🔁 ${meta.loopCount || 0}</span>
            </div>

            <div class="vsm-adjust-row">
              <button class="vsm-adjust-btn vsm-adj-sm" title="Start -${step}s">◀</button>
              <span class="vsm-adjust-label" style="color:${colorObj.main}">S</span>
              <button class="vsm-adjust-btn vsm-adj-sp" title="Start +${step}s">▶</button>
              <span class="vsm-adjust-sep"></span>
              <button class="vsm-adjust-btn vsm-adj-em" title="End -${step}s">◀</button>
              <span class="vsm-adjust-label" style="color:${colorObj.main}">E</span>
              <button class="vsm-adjust-btn vsm-adj-ep" title="End +${step}s">▶</button>
            </div>
          `);

        row.querySelector('.vsm-region-delete').onclick = (e) => { e.stopPropagation(); this.app.engine.deleteRegion(regionIdx); };
        row.querySelector('.vsm-adj-sm').onclick = (e) => { e.stopPropagation(); this.app.engine.adjustRegionBound(regionIdx, 'start', -step); };
        row.querySelector('.vsm-adj-sp').onclick = (e) => { e.stopPropagation(); this.app.engine.adjustRegionBound(regionIdx, 'start', +step); };
        row.querySelector('.vsm-adj-em').onclick = (e) => { e.stopPropagation(); this.app.engine.adjustRegionBound(regionIdx, 'end', -step); };
        row.querySelector('.vsm-adj-ep').onclick = (e) => { e.stopPropagation(); this.app.engine.adjustRegionBound(regionIdx, 'end', +step); };

        row.querySelector('.vsm-bookmark-btn').onclick = (e) => {
          e.stopPropagation();
          meta.bookmark = !meta.bookmark;
          this.app.storage.saveSceneData();
          this.updateOverlayButtons();
        };

        const labelInput = row.querySelector('.vsm-label-input');

        labelInput.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') labelInput.blur();
          if (e.key === ' ') {
            e.preventDefault();
            const startPos = labelInput.selectionStart;
            const endPos = labelInput.selectionEnd;
            labelInput.value = labelInput.value.substring(0, startPos) + ' ' + labelInput.value.substring(endPos);
            labelInput.selectionStart = labelInput.selectionEnd = startPos + 1;
            labelInput.dispatchEvent(new Event('change'));
          }
        }, true);

        labelInput.addEventListener('change', (e) => {
          meta.label = e.target.value;
          this.app.storage.saveSceneData();
        });

        const mergeBtn = row.querySelector('.vsm-region-merge');
        if (mergeBtn) {
          mergeBtn.onclick = (e) => {
            e.stopPropagation();
            row.innerHTML = window.VSM.safeHTML(`
                <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; min-height:85px; padding:5px; gap:8px;">
                  <span style="font-size:10px; font-weight:bold; color:#ddd;">MERGE R${regionIdx + 1} WITH:</span>
                  <div style="display:flex; gap:8px;">
                     ${regionIdx > 0 ? `<button id="mrg-prev" class="vsm-btn vsm-btn-blue" style="margin:0; padding:6px 10px; font-size:9px;">◀ PREV (R${regionIdx})</button>` : ''}
                     ${regionIdx < numRegions - 1 ? `<button id="mrg-next" class="vsm-btn vsm-btn-blue" style="margin:0; padding:6px 10px; font-size:9px;">NEXT (R${regionIdx + 2}) ▶</button>` : ''}
                  </div>
                  <button id="mrg-cancel" class="vsm-btn vsm-btn-red" style="margin:0; padding:3px 10px; font-size:8px; width:auto;">Cancel</button>
                </div>
              `);
            row.onclick = (ev) => ev.stopPropagation();
            row.querySelector('#mrg-prev')?.addEventListener('click', (ev) => { ev.stopPropagation(); this.app.engine.mergeRegions(regionIdx - 1, regionIdx); });
            row.querySelector('#mrg-next')?.addEventListener('click', (ev) => { ev.stopPropagation(); this.app.engine.mergeRegions(regionIdx, regionIdx + 1); });
            row.querySelector('#mrg-cancel')?.addEventListener('click', (ev) => { ev.stopPropagation(); this.updateOverlayButtons(); });
          };
        }

        list.appendChild(row);
      }

      if (rowToScroll) setTimeout(() => rowToScroll.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    }

    updateActiveRegionHighlight() {
      const list = document.getElementById('vsm-region-list');
      if (!list) return;
      list.querySelectorAll('.vsm-region-row').forEach((row, idx) => {
        if (idx === this.app.engine.currentRegionIdx) {
          row.classList.add('vsm-active');
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else row.classList.remove('vsm-active');
      });
    }

    renderTimelineCheckpoints() {
      if (!this.app.player) return;
      const dur = this.app.player.duration();
      if (!dur || isNaN(dur) || dur <= 0) return setTimeout(() => this.renderTimelineCheckpoints(), 200);

      const progressHolder = this.app.player.el().querySelector('.vjs-progress-holder');
      if (!progressHolder) return;

      progressHolder.querySelectorAll('.vjs-loop-checkpoint, .vjs-loop-region-highlight').forEach(el => el.remove());
      const points = this.app.engine.loopPoints;

      for (let i = 0; i < points.length - 1; i += 2) {
        const colorObj = this.REGION_COLORS[(i / 2) % this.REGION_COLORS.length];
        const startPct = (points[i] / dur) * 100;
        const endPct = (points[i + 1] / dur) * 100;

        const region = document.createElement('div');
        region.className = 'vjs-loop-region-highlight';
        region.style.left = startPct + '%'; region.style.width = (endPct - startPct) + '%';
        region.style.setProperty('--region-bg', this.app.engine.isLooping ? colorObj.bg : 'rgba(255,255,255,0.05)');
        progressHolder.appendChild(region);

        const createDraggablePoint = (pct, pointIndex, isStart) => {
          const cp = document.createElement('div');
          cp.className = 'vjs-loop-checkpoint';
          cp.style.left = pct + '%';
          cp.style.setProperty('--region-color', colorObj.main);
          cp.title = isStart ? 'Drag to adjust Start' : 'Drag to adjust End';

          cp.onmousedown = (e) => {
            e.preventDefault(); e.stopPropagation();
            this.app.engine.isDraggingZoom = true;
            const oldTime = points[pointIndex];

            const onMove = (moveEv) => {
              const rect = progressHolder.getBoundingClientRect();
              let newPct = (moveEv.clientX - rect.left) / rect.width;
              let newTime = Math.max(0, Math.min(1, newPct)) * dur;

              if (isStart) {
                const maxLim = points[pointIndex + 1] - 0.1;
                const minLim = pointIndex > 0 ? points[pointIndex - 1] + 0.1 : 0;
                newTime = Math.min(maxLim, Math.max(minLim, newTime));
              } else {
                const minLim = points[pointIndex - 1] + 0.1;
                const maxLim = pointIndex < points.length - 1 ? points[pointIndex + 1] - 0.1 : dur;
                newTime = Math.max(minLim, Math.min(maxLim, newTime));
              }

              this.app.engine.loopPoints[pointIndex] = parseFloat(newTime.toFixed(2));
              this.renderTimelineCheckpoints();
              this.updateOverlayButtons();
            };

            const onUp = async () => {
              document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
              this.app.engine.isDraggingZoom = false;

              const newTime = points[pointIndex];
              if (Math.round(oldTime) !== Math.round(newTime)) {
                delete this.app.engine.timeThumbs[Math.round(oldTime)];
              }

              this.app.engine.updateThumbnailForTime(newTime, Math.floor(pointIndex / 2));
              await this.app.storage.saveSceneData();
            };

            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
          };
          progressHolder.appendChild(cp);
        };

        createDraggablePoint(startPct, i, true);
        createDraggablePoint(endPct, i + 1, false);
      }
    }

    createPopup() {
      if (document.getElementById('videoShortcutPopup')) return;

      const popupHTML = window.VSM.safeHTML(`
          <div id="videoShortcutPopup" class="vsm-popup" style="display: none;">
            <div class="vsm-popup-header">
              <h3 style="margin: 0; color: #00d1b2;">Video Shortcuts Manager</h3>
              <div style="display:flex; gap:12px;">
                  <button id="vsm-popup-dash" style="background:#2196F3; color:#fff; border:none; padding:4px 10px; border-radius:4px; font-weight:bold; cursor:pointer; font-size:12px;">📊 Overview Dashboard</button>
                  <button id="vsm-close-popup" style="background: none; border: none; color: #888; cursor: pointer; font-size: 24px; line-height: 1;">&times;</button>
              </div>
            </div>

            <div class="vsm-popup-body">
              <div class="vsm-popup-col">
                <h4 class="vsm-section-title">Keyboard Shortcuts</h4>
                <div id="shortcutList" class="vsm-popup-scrollable"></div>
              </div>

              <div class="vsm-popup-col">
                <div class="vsm-popup-scrollable" style="background:transparent; border:none; padding:0; padding-right: 4px;">

                  <div class="vsm-settings-section">
                    <h4 class="vsm-section-title">Add New Shortcut</h4>
                    <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                      <select id="newShortcutAction" style="flex: 2; padding: 6px; background: #222; color: white; border: 1px solid #555; border-radius: 4px; font-size: 12px; outline:none;">
                        <option value="seekForward">Seek Forward</option>
                        <option value="seekBackward">Seek Backward</option>
                        <option value="togglePlay">Toggle Play/Pause</option>
                        <option value="toggleMute">Toggle Mute</option>
                        <option value="toggleFullscreen">Toggle Fullscreen</option>
                        <option value="addLoopPoint">Add Loop Point</option>
                        <option value="toggleLoop">Toggle Loop</option>
                        <option value="splitRegion">Split Region</option>
                        <option value="clearLoops">Clear All Loops</option>
                        <option value="prevRegion">Go to Prev Region</option>
                        <option value="nextRegion">Go to Next Region</option>
                        <option value="adjStartBack">Adjust Start Back</option>
                        <option value="adjStartFwd">Adjust Start Forward</option>
                        <option value="adjEndBack">Adjust End Back</option>
                        <option value="adjEndFwd">Adjust End Forward</option>
                      </select>
                      <input type="number" id="newShortcutValue" placeholder="Secs" style="flex: 1; width: 50px; padding: 6px; background: #222; color: white; border: 1px solid #555; border-radius: 4px; font-size: 12px; outline:none;">
                    </div>
                    <button id="addNewShortcut" class="vsm-btn vsm-btn-green" style="margin:0;">Add Key</button>
                  </div>

                  <div class="vsm-settings-section">
                    <h4 class="vsm-section-title">Cloud Sync Engine</h4>
                    <label class="vsm-label"><span style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="vsm-useSupabase"> Enable Supabase Sync</span></label>
                    <div style="height:4px;"></div>
                    <label class="vsm-label">Auto-Push Delay:
                        <div style="display:flex; gap:4px;">
                            <input type="number" id="vsm-autoPushDelay" min="0" style="width:40px;">
                            <select id="vsm-autoPushUnit">
                                <option value="1000">Sec</option>
                                <option value="60000">Min</option>
                            </select>
                        </div>
                    </label>
                    <label class="vsm-label">Auto-Pull Interval:
                        <div style="display:flex; gap:4px;">
                            <input type="number" id="vsm-syncPullInterval" min="0" title="0 to disable auto-pull (Manual Only)" style="width:40px;">
                            <select id="vsm-syncPullUnit">
                                <option value="60000">Min</option>
                                <option value="3600000">Hrs</option>
                                <option value="86400000">Days</option>
                            </select>
                        </div>
                    </label>
                    <div style="height:8px;"></div>
                    <div style="display:flex; gap:6px;">
                        <button id="vsm-btn-manual-push" class="vsm-btn vsm-btn-green" style="margin:0; font-size:11px;">☁️ Push Local to Cloud</button>
                        <button id="vsm-btn-manual-pull" class="vsm-btn vsm-btn-blue" style="margin:0; font-size:11px;">☁️ Pull Cloud to Local</button>
                    </div>
                  </div>

                  <div class="vsm-settings-section">
                    <h4 class="vsm-section-title">UI Settings</h4>
                    <label class="vsm-label"><span style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="vsm-useStashDB"> Save to StashDB (Local)</span></label>
                    <label class="vsm-label"><span style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="vsm-hideProgressBar"> Hide Progress Bar</span></label>
                    <label class="vsm-label"><span style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="vsm-hideControlBar"> Hide Toolbar</span></label>
                    <label class="vsm-label" style="color:#00d1b2;"><span style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="vsm-navBookmarksOnly"> Navigate Bookmarked Regions Only</span></label>
                    <div style="height:10px;"></div>
                    <label class="vsm-label">Master Step (s): <input type="number" step="0.05" id="vsm-microStep"></label>
                    <label class="vsm-label">Zoom Sens: <input type="number" step="0.001" id="vsm-zoomSense"></label>
                    <label class="vsm-label">Pan Sens: <input type="number" step="0.1" id="vsm-panSense"></label>
                  </div>

                  <div class="vsm-settings-section">
                    <h4 class="vsm-section-title">Data Management</h4>
                    <button id="vsm-reset" class="vsm-btn vsm-btn-red" style="margin-top:5px;">Reset All to Default</button>
                  </div>

                </div>
              </div>
            </div>
          </div>
        `);

      document.body.insertAdjacentHTML('beforeend', popupHTML);
      document.getElementById('vsm-close-popup').onclick = () => this.hidePopup();
      document.getElementById('vsm-popup-dash').onclick = () => { this.hidePopup(); this.openDashboard(); };
    }

    showPopup() {
      const popup = document.getElementById('videoShortcutPopup');
      if (!popup) return;

      const playerEl = this.app.player ? this.app.player.el() : document.body;
      if (popup.parentElement !== playerEl) {
        playerEl.appendChild(popup);
      }

      popup.style.display = 'flex';

      const s = this.app.storage.settings;

      const setVal = (id, prop, val) => { const el = document.getElementById(id); if (el) el[prop] = val; };

      setVal('vsm-useStashDB', 'checked', s.useStashDB);
      setVal('vsm-useSupabase', 'checked', s.useSupabase);
      setVal('vsm-hideProgressBar', 'checked', s.hideUI.progressBar);
      setVal('vsm-hideControlBar', 'checked', s.hideUI.controlBar);
      setVal('vsm-navBookmarksOnly', 'checked', s.navBookmarksOnly);
      setVal('vsm-microStep', 'value', s.microAdjustStep);
      setVal('vsm-zoomSense', 'value', s.zoomSensitivity);
      setVal('vsm-panSense', 'value', s.panSensitivity);

      setVal('vsm-syncPullInterval', 'value', s.syncPullInterval);
      setVal('vsm-syncPullUnit', 'value', s.syncPullUnit.toString());
      setVal('vsm-autoPushDelay', 'value', s.autoPushDelay);
      setVal('vsm-autoPushUnit', 'value', s.autoPushUnit.toString());

      this.app.input.createShortcutInputs();

      document.addEventListener('mousedown', this.clickOutsideHandler, true);
      document.addEventListener('keydown', this.escHandler, true);
    }

    hidePopup() {
      const popup = document.getElementById('videoShortcutPopup');
      if (popup) popup.style.display = 'none';

      this.app.input.stopCapturingKey();

      document.removeEventListener('mousedown', this.clickOutsideHandler, true);
      document.removeEventListener('keydown', this.escHandler, true);
    }

    // ==========================================
    // MASTER DASHBOARD UI
    // ==========================================
    createDashboard() {
      if (document.getElementById('vsm-dashboard-modal')) return;
      const html = window.VSM.safeHTML(`
        <div id="vsm-dashboard-modal" class="vsm-dash-overlay">
          <div class="vsm-dash-content">
            <div class="vsm-dash-header">
              <h2>📊 Overview <span id="vsm-dash-count" style="font-size:14px; color:#94a3b8; font-weight:normal; margin-left:8px;">(0 videos)</span></h2>
              <div class="vsm-dash-controls">
                 <button id="vsm-dash-sync-meta" class="vsm-btn-blue" style="margin:0; padding:6px 12px; font-size:12px; width:auto;">🔗 Sync Missing Metadata</button>
                 <input type="text" id="vsm-dash-search" placeholder="🔍 Search Title, Code, Path, or Labels..." class="vsm-dash-search">
                 <button id="vsm-dash-close" class="vsm-dash-close">&times;</button>
              </div>
            </div>
            <div class="vsm-dash-table-container">
              <table class="vsm-dash-table">
                <thead>
                  <tr>
                    <th style="width: 140px;">Cover</th>
                    <th style="width: 280px;">Video Info</th>
                    <th>Regions & Labels</th>
                    <th style="width: 80px; text-align:center;">Loops</th>
                    <th style="width: 60px; text-align:center;">Action</th>
                  </tr>
                </thead>
                <tbody id="vsm-dash-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      `);
      document.body.insertAdjacentHTML('beforeend', html);
      document.getElementById('vsm-dash-close').onclick = () => document.getElementById('vsm-dashboard-modal').classList.remove('active');

      const searchInp = document.getElementById('vsm-dash-search');
      searchInp.addEventListener('input', () => this.filterDashboard(searchInp.value));

      document.getElementById('vsm-dash-sync-meta').onclick = async (e) => {
        e.target.innerText = "☁️ Scrape & Sync... (Please wait)";
        e.target.disabled = true;
        try {
          await this.app.storage.forceManualSync();
          await this.app.storage.scrapeAllStashMetadata();
          await this.openDashboard();
        } catch (err) {
          window.VSM.Log.error('Dashboard', 'Sync sequence failed', err);
          alert("Sync failed. Check console for details.");
        }
        e.target.innerText = "🔗 Sync Missing Metadata";
        e.target.disabled = false;
      };
    }

    async openDashboard() {
      const modal = document.getElementById('vsm-dashboard-modal');
      if (!modal) return;

      const playerEl = this.app.player ? this.app.player.el() : document.body;
      if (modal.parentElement !== playerEl) playerEl.appendChild(modal);

      modal.classList.add('active');
      const tbody = document.getElementById('vsm-dash-tbody');
      tbody.innerHTML = window.VSM.safeHTML(`<tr><td colspan="5" style="text-align:center; padding: 40px; color:#00d1b2;">Loading Database...</td></tr>`);

      const keys = await this.app.storage.idbKeys();
      const rowsData = [];

      for (const key of keys) {
        if (!key.startsWith('vsm_hash_') && !key.startsWith('vsm_os_')) continue;

        try {
          const raw = await this.app.storage.idbGet(key);
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (!data || !data.loopPoints || data.loopPoints.length === 0) continue;

          const meta = data.sceneMetadata || { title: 'Unknown Video', code: '', studio: '', id: null, path: '' };
          let coverUrl = '';
          if (data.timeThumbs) {
            const firstTime = Object.keys(data.timeThumbs)[0];
            if (firstTime) coverUrl = data.timeThumbs[firstTime];
          }

          const numRegions = Math.floor(data.loopPoints.length / 2);
          let totalLoops = 0;
          let labelsHtml = '';
          for (let r = 0; r < numRegions; r++) {
            const rMeta = data.regionMeta?.[r] || { bookmark: false, label: '', loopCount: 0 };
            totalLoops += (rMeta.loopCount || 0);
            if (rMeta.bookmark || rMeta.label) {
              labelsHtml += `<span class="vsm-dash-label-tag ${rMeta.bookmark ? 'bm' : ''}">${rMeta.bookmark ? '⭐ ' : ''}${rMeta.label || ('R' + (r + 1))}</span> `;
            }
          }

          rowsData.push({
            key: key,
            meta: meta,
            coverUrl: coverUrl,
            numRegions: numRegions,
            totalLoops: totalLoops,
            labelsHtml: labelsHtml,
            rawLabels: data.regionMeta?.map(rm => rm.label).join(' ') || '',
            lastUpdated: data.lastUpdated || 0
          });

        } catch (e) { }
      }

      rowsData.sort((a, b) => b.lastUpdated - a.lastUpdated);
      this.dashboardData = rowsData;
      this.filterDashboard(document.getElementById('vsm-dash-search').value || '');
    }

    filterDashboard(query) {
      const tbody = document.getElementById('vsm-dash-tbody');
      const countEl = document.getElementById('vsm-dash-count');
      if (!tbody || !this.dashboardData) return;

      const q = query.toLowerCase().trim();
      const filtered = this.dashboardData.filter(d => {
        if (!q) return true;
        const txt = `${d.meta.title} ${d.meta.code} ${d.meta.studio} ${d.meta.path} ${d.rawLabels}`.toLowerCase();
        return txt.includes(q);
      });

      countEl.textContent = `(${filtered.length} videos)`;

      if (filtered.length === 0) {
        tbody.innerHTML = window.VSM.safeHTML(`<tr><td colspan="5" style="text-align:center; padding: 40px; color:#94a3b8;">No videos found matching your search.</td></tr>`);
        return;
      }

      let html = '';
      filtered.forEach(d => {
        const titleSafe = d.meta.title ? d.meta.title.replace(/</g, '&lt;') : 'Unknown';
        const codeSafe = d.meta.code ? `<span class="vsm-dash-code">${d.meta.code}</span>` : '';
        const studioSafe = d.meta.studio ? `<div class="vsm-dash-studio">${d.meta.studio}</div>` : '';
        const pathSafe = d.meta.path ? `<div class="vsm-dash-path" title="${d.meta.path}">${d.meta.path.split('/').pop()}</div>` : '';

        let playUrl = '#';
        if (d.meta.id && d.meta.id !== 'universal_web_video') {
          playUrl = `/scenes/${d.meta.id}?continue=true`;
        } else if (d.meta.path && d.meta.path.startsWith('http')) {
          playUrl = d.meta.path;
        }

        html += `
             <tr class="vsm-dash-tr" data-url="${playUrl}">
                <td><img src="${d.coverUrl}" class="vsm-dash-cover" loading="lazy" onerror="this.style.display='none'"></td>
                <td>
                   ${studioSafe}
                   <div class="vsm-dash-title">${codeSafe} ${titleSafe}</div>
                   ${pathSafe}
                </td>
                <td>
                   <div style="font-size:11px; color:#94a3b8; margin-bottom:4px;">${d.numRegions} Regions</div>
                   ${d.labelsHtml}
                </td>
                <td style="text-align:center; font-weight:bold; color:#00d1b2;">${d.totalLoops}</td>
                <td style="text-align:center;">
                   <a href="${playUrl}" class="vsm-dash-play-btn" ${playUrl === '#' ? 'style="opacity:0.3; pointer-events:none;"' : ''}>▶</a>
                </td>
             </tr>
          `;
      });

      tbody.innerHTML = window.VSM.safeHTML(html);

      tbody.querySelectorAll('.vsm-dash-tr').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          const url = tr.getAttribute('data-url');
          if (url && url !== '#') window.location.href = url;
        });
      });
    }

    bindPopupEvents() {
      const st = this.app.storage;
      const bind = (id, eventType, handler) => { const el = document.getElementById(id); if (el) el.addEventListener(eventType, handler); };

      bind('vsm-useStashDB', 'change', async (e) => { st.settings.useStashDB = e.target.checked; await st.saveGlobalSettings(); });
      bind('vsm-useSupabase', 'change', async (e) => { st.settings.useSupabase = e.target.checked; await st.saveGlobalSettings(); });
      bind('vsm-hideProgressBar', 'change', async (e) => { st.settings.hideUI.progressBar = e.target.checked; await st.saveGlobalSettings(); this.updateUIVisibility(); });
      bind('vsm-hideControlBar', 'change', async (e) => { st.settings.hideUI.controlBar = e.target.checked; await st.saveGlobalSettings(); this.updateUIVisibility(); });
      bind('vsm-navBookmarksOnly', 'change', async (e) => { st.settings.navBookmarksOnly = e.target.checked; await st.saveGlobalSettings(); });

      bind('vsm-microStep', 'change', async (e) => {
        let val = parseFloat(e.target.value) || 0.1; st.settings.microAdjustStep = val; await st.saveGlobalSettings();
        this.updateOverlayButtons(); const overlayStep = document.getElementById('vsm-overlay-step'); if (overlayStep) overlayStep.value = val;
      });
      bind('vsm-zoomSense', 'change', async (e) => { let val = parseFloat(e.target.value); if (isNaN(val) || val <= 0) val = 0.008; st.settings.zoomSensitivity = val; await st.saveGlobalSettings(); });
      bind('vsm-panSense', 'change', async (e) => { let val = parseFloat(e.target.value); if (isNaN(val) || val <= 0) val = 0.3; st.settings.panSensitivity = val; await st.saveGlobalSettings(); });

      bind('vsm-syncPullInterval', 'change', async (e) => {
        const val = parseInt(e.target.value);
        st.settings.syncPullInterval = isNaN(val) ? 0 : Math.max(0, val);
        await st.saveGlobalSettings();
        st.startPullTimer();
      });
      bind('vsm-syncPullUnit', 'change', async (e) => {
        st.settings.syncPullUnit = parseInt(e.target.value);
        await st.saveGlobalSettings();
        st.startPullTimer();
      });

      bind('vsm-autoPushDelay', 'change', async (e) => {
        const val = parseInt(e.target.value);
        st.settings.autoPushDelay = isNaN(val) ? 0 : Math.max(0, val);
        await st.saveGlobalSettings();
      });
      bind('vsm-autoPushUnit', 'change', async (e) => {
        st.settings.autoPushUnit = parseInt(e.target.value);
        await st.saveGlobalSettings();
      });

      bind('vsm-btn-manual-push', 'click', async (e) => {
        e.target.innerText = "☁️ Pushing..."; e.target.disabled = true;
        if (st.pushDebounceTimer) { clearTimeout(st.pushDebounceTimer); st.pushDebounceTimer = null; }
        await st.executeSmartPush();
        e.target.innerText = "☁️ Push Local to Cloud"; e.target.disabled = false;
      });

      bind('vsm-btn-manual-pull', 'click', async (e) => {
        e.target.innerText = "☁️ Pulling..."; e.target.disabled = true;
        await st.executeSmartPull();
        e.target.innerText = "☁️ Pull Cloud to Local"; e.target.disabled = false;
      });

      bind('vsm-reset', 'click', async () => { if (confirm("Are you sure you want to reset all shortcuts to defaults?")) { st.settings = { ...st.DEFAULT_SETTINGS }; await st.saveGlobalSettings(); this.showPopup(); } });

      const addBtn = document.getElementById('addNewShortcut');
      if (addBtn) {
        addBtn.onclick = () => {
          const action = document.getElementById('newShortcutAction')?.value; const valInput = document.getElementById('newShortcutValue'); const val = valInput?.value ? parseFloat(valInput.value) : null;
          if (!action) return;
          if (['seekForward', 'seekBackward'].includes(action) && (val === null || isNaN(val) || val <= 0)) { return alert('Enter a valid number for seconds for seeking.'); }
          this.app.input.startCapturingNewKey(action, val, addBtn);
        };
      }
    }

    formatTime(s) { const m = Math.floor(s / 60); return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`; }

    injectCSS() {
      const style = document.createElement('style');
      style.textContent = window.VSM.safeHTML(`
          .video-js:focus, .video-js *:focus { outline: none !important; }
          .vjs-loop-checkpoint { position: absolute; top: 0; width: 6px; margin-left: -3px; height: 100%; background: var(--region-color, #00d1b2); z-index: 10; cursor: ew-resize; box-shadow: 0 0 5px rgba(0, 209, 178, 0.8); }
          .vjs-loop-region-highlight { position: absolute; top: 0; height: 100%; background: var(--region-bg, rgba(0, 209, 178, 0.15)); z-index: 5; pointer-events: none; }
          .vsm-overlay-container { position: absolute; top: 15px; left: 15px; display: flex; flex-direction: column; z-index: 100; opacity: 1; transition: opacity 0.2s, transform 0.2s; background: rgba(12, 12, 12, 0.9); backdrop-filter: blur(12px); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 8px 24px rgba(0,0,0,0.7); width: 270px; }
          .vsm-overlay-container.vsm-hidden { opacity: 0; pointer-events: none; transform: translateX(-10px); }
          .vsm-header { font-size: 9px; font-weight: 800; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px; display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px; }
          .vsm-region-list-scroll { max-height: 340px; overflow-y: auto; overflow-x: hidden; margin-bottom: 2px; scroll-behavior: smooth; }
          .vsm-region-list-scroll::-webkit-scrollbar { width: 3px; }
          .vsm-region-list-scroll::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
          .vsm-region-row { position: relative; display: flex; flex-direction: column; padding: 4px; cursor: pointer; border-radius: 5px; border: 1px solid transparent; transition: background 0.15s, border-color 0.15s; margin-bottom: 3px; }
          .vsm-region-row:hover { background: rgba(255,255,255,0.06); }
          @keyframes vsmActivePulse { 0% { background: rgba(0, 209, 178, 0.08); border-color: rgba(0,209,178,0.3); box-shadow: 0 0 5px rgba(0,209,178,0.1); } 50% { background: rgba(0, 209, 178, 0.2); border-color: rgba(0,209,178,0.8); box-shadow: 0 0 15px rgba(0,209,178,0.3); } 100% { background: rgba(0, 209, 178, 0.08); border-color: rgba(0,209,178,0.3); box-shadow: 0 0 5px rgba(0,209,178,0.1); } }
          .vsm-region-row.vsm-active { animation: vsmActivePulse 2s infinite ease-in-out; z-index: 5; }
          .vsm-region-delete { position: absolute; top: 3px; right: 3px; width: 15px; height: 15px; background: rgba(255,56,96,0.15); border: 1px solid rgba(255,56,96,0.35); border-radius: 3px; color: #ff3860; font-size: 9px; line-height: 13px; text-align: center; cursor: pointer; display: none; padding: 0; z-index: 10; font-weight:bold; }
          .vsm-region-delete:hover { background: rgba(255,56,96,0.4) !important; }
          .vsm-region-row:hover .vsm-region-delete { display: block; }
          .vsm-region-merge { position: absolute; top: 3px; right: 22px; width: 15px; height: 15px; background: rgba(33, 150, 243, 0.15); border: 1px solid rgba(33, 150, 243, 0.35); border-radius: 3px; color: #2196F3; font-size: 8px; line-height: 13px; text-align: center; cursor: pointer; display: none; padding: 0; z-index: 10; font-weight:bold; }
          .vsm-region-merge:hover { background: rgba(33, 150, 243, 0.4) !important; }
          .vsm-region-row:hover .vsm-region-merge { display: block; }
          .vsm-region-thumbs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; pointer-events: none; }
          .vsm-region-thumb { width: 100%; height: auto; object-fit: cover; border-radius: 3px; display: block; }
          .vsm-thumb-wrap { position: relative; }
          .vsm-thumb-tag { position: absolute; bottom: 2px; left: 2px; font-size: 7px; font-weight: 700; color: rgba(255,255,255,0.7); background: rgba(0,0,0,0.55); padding: 0 3px; border-radius: 2px; }
          .vsm-region-thumb-placeholder { width: 100%; height: 60px; border-radius: 3px; background: #111; display: flex; align-items: center; justify-content: center; font-size: 7px; color: #333; }
          .vsm-region-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; pointer-events: none; }
          .vsm-region-label { font-size: 9px; font-weight: 700; color: #bbb; display: flex; align-items: center; gap: 3px; }
          .vsm-region-indicator { width: 3px; height: 10px; border-radius: 2px; display: inline-block; flex-shrink: 0; }
          .vsm-region-duration { font-size: 9px; font-weight: 700; color: #00d1b2; background: rgba(0,209,178,0.08); padding: 1px 4px; border-radius: 3px; }

          /* New Meta Elements */
          .vsm-bookmark-btn { background:none; border:1px solid #444; color:#666; border-radius:3px; padding:2px; cursor:pointer; font-size:10px; transition:0.2s; }
          .vsm-bookmark-btn:hover { background:rgba(255,255,255,0.1); border-color:#888; }
          .vsm-bookmark-btn.active { color:#ffdd57; border-color:#ffdd57; background:rgba(255, 221, 87, 0.1); }
          .vsm-label-input { flex:1; background:rgba(0,0,0,0.4); border:1px solid #444; color:#fff; font-size:9px; padding:2px 4px; border-radius:3px; outline:none; min-width:0; }
          .vsm-label-input:focus { border-color:#00d1b2; background:rgba(0, 209, 178, 0.1); }
          .vsm-loop-count { font-size:9px; color:#888; font-weight:bold; background:rgba(255,255,255,0.05); padding:2px 4px; border-radius:3px; user-select:none;}

          .vsm-controls { display: flex; gap: 3px; margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; }
          .vsm-overlay-btn { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #ddd; padding: 4px 0; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600; text-align: center; }
          .vsm-overlay-btn:hover { background: rgba(255,255,255,0.12); }
          .vsm-overlay-btn.vsm-active { background: rgba(0,209,178,0.2) !important; border-color: #00d1b2 !important; color: #00d1b2 !important; }
          .vsm-zoom-badge { position: absolute; bottom: 50px; right: 10px; padding: 3px 7px; background: rgba(0,0,0,0.65); color: #00d1b2; border-radius: 4px; font-size: 11px; font-weight: 700; z-index: 20; pointer-events: none; display: none; }
          .vsm-adjust-row { display: flex; align-items: center; gap: 2px; margin-top: 3px; pointer-events: auto; }
          .vsm-adjust-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: #888; border-radius: 3px; font-size: 9px; padding: 1px 5px; cursor: pointer; }
          .vsm-adjust-btn:hover { background: rgba(255,255,255,0.18); color: #fff; }
          .vsm-adjust-label { font-size: 8px; text-transform: uppercase; flex: 1; text-align: center; font-weight: 700; }

          /* Existing Popup CSS */
          .vsm-popup { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(25, 25, 25, 0.95); backdrop-filter: blur(15px); padding: 20px; border-radius: 10px; z-index: 999999; color: #eee; width: 800px; max-width: 95%; height: 75vh; max-height: 800px; flex-direction: column; box-shadow: 0 15px 50px rgba(0,0,0,0.8); border: 1px solid rgba(255,255,255,0.1); font-family: sans-serif; }
          .vsm-popup-header { flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 15px; }
          .vsm-popup-body { display: grid; grid-template-columns: 1fr 1fr; gap: 25px; overflow: hidden; flex: 1; }
          .vsm-popup-col { display: flex; flex-direction: column; overflow: hidden; }
          .vsm-popup-scrollable { flex: 1; overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 6px; padding: 10px; border: 1px solid rgba(255,255,255,0.05); }
          .vsm-popup-scrollable::-webkit-scrollbar { width: 6px; }
          .vsm-popup-scrollable::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
          .vsm-settings-section { background: rgba(0,0,0,0.3); padding: 15px; border-radius: 6px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.05); }
          .vsm-section-title { margin: 0 0 12px 0; color: #00d1b2; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; }
          .vsm-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; color: #ddd; }
          .vsm-label input[type="number"], .vsm-label input[type="text"], .vsm-label input[type="password"] { background: #222; color: white; border: 1px solid #555; border-radius: 4px; padding: 4px 6px; outline:none; }
          .vsm-label input[type="number"], .vsm-label select { width: 70px; text-align: right; background: #222; color: white; border: 1px solid #555; border-radius: 4px; padding: 4px 6px; outline:none; }
          .vsm-btn { width: 100%; padding: 8px; margin-bottom: 8px; border: none; border-radius: 4px; color: white; cursor: pointer; font-weight: bold; transition: background 0.2s; }
          .vsm-btn-blue { background: #2196F3; } .vsm-btn-blue:hover { background: #1976D2; }
          .vsm-btn-green { background: #4CAF50; } .vsm-btn-green:hover { background: #388E3C; }
          .vsm-btn-red { background: #f44336; } .vsm-btn-red:hover { background: #D32F2F; }

          /* Dashboard CSS */
          .vsm-dash-overlay { position: fixed; inset:0; background: rgba(15,23,42,0.8); backdrop-filter: blur(5px); z-index: 9999999; display: none; align-items: center; justify-content: center; font-family: sans-serif; }
          .vsm-dash-overlay.active { display: flex; }
          .vsm-dash-content { background: #f1f5f9; width: 95vw; height: 90vh; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
          .vsm-dash-header { background: #fff; padding: 16px 24px; border-bottom: 1px solid #cbd5e1; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
          .vsm-dash-header h2 { margin: 0; font-size: 20px; color: #0f172a; display: flex; align-items: center; }
          .vsm-dash-controls { display: flex; gap: 16px; align-items: center; }
          .vsm-dash-search { padding: 8px 16px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; width: 350px; outline: none; transition: 0.2s; }
          .vsm-dash-search:focus { border-color: #00d1b2; box-shadow: 0 0 0 3px rgba(0,209,178,0.2); }
          .vsm-dash-close { background: none; border: none; font-size: 28px; color: #64748b; cursor: pointer; line-height: 1; transition: 0.2s; }
          .vsm-dash-close:hover { color: #ef4444; }
          .vsm-dash-table-container { flex: 1; overflow: auto; padding: 24px; }
          .vsm-dash-table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
          .vsm-dash-table th { position: sticky; top: -24px; background: #f1f5f9; color: #64748b; text-transform: uppercase; font-size: 11px; font-weight: 700; padding: 0 16px 8px; text-align: left; z-index: 10; border-bottom: 2px solid #cbd5e1; }
          .vsm-dash-tr { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: 0.2s; cursor: pointer; }
          .vsm-dash-tr:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .vsm-dash-tr td { padding: 12px 16px; vertical-align: middle; border-top: 1px solid transparent; border-bottom: 1px solid transparent; }
          .vsm-dash-tr td:first-child { border-top-left-radius: 8px; border-bottom-left-radius: 8px; border-left: 1px solid transparent; }
          .vsm-dash-tr td:last-child { border-top-right-radius: 8px; border-bottom-right-radius: 8px; border-right: 1px solid transparent; }
          .vsm-dash-cover { width: 120px; height: 68px; object-fit: cover; border-radius: 6px; background: #e2e8f0; }
          .vsm-dash-code { display: inline-block; background: #e0f2fe; color: #2563eb; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; font-family: monospace; margin-right: 6px; }
          .vsm-dash-studio { font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
          .vsm-dash-title { font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
          .vsm-dash-path { font-size: 11px; color: #64748b; font-family: monospace; word-break: break-all; }
          .vsm-dash-label-tag { display: inline-block; background: #f1f5f9; border: 1px solid #cbd5e1; color: #475569; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 12px; margin: 2px 2px 0 0; }
          .vsm-dash-label-tag.bm { background: #fef9c3; border-color: #fde047; color: #854d0e; }
          .vsm-dash-play-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: #00d1b2; color: #fff; text-decoration: none; font-size: 14px; transition: 0.2s; box-shadow: 0 4px 10px rgba(0, 209, 178, 0.3); }
          .vsm-dash-play-btn:hover { background: #00b89c; transform: scale(1.1); }
        `);
      document.head.appendChild(style);
    }
  };

  // ==========================================
  // 4. INPUT MODULE
  // ==========================================
  window.VSM.Input = class {
    constructor(app) {
      this.app = app;
      this.isCapturingKey = false;
      this.isCapturingNewKey = false;
      this.editingKey = null;
      this.newShortcutConfig = null;
      this.capturedKeys = new Set();
      this.bindMethods();
    }

    bindMethods() {
      this.globalKeyDown = this.globalKeyDown.bind(this);
      this.captureDown = this.captureDown.bind(this);
      this.captureUp = this.captureUp.bind(this);
    }

    init() {
      document.addEventListener('keydown', this.globalKeyDown, true);
    }

    globalKeyDown(event) {
      if (this.isCapturingKey || this.isCapturingNewKey) return;

      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      if (((isMac && event.metaKey) || (!isMac && event.ctrlKey)) && event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        this.app.ui.showPopup(); return;
      }

      if (!this.app.player || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (document.getElementById('videoShortcutPopup')?.style.display !== 'none') return;
      if (document.getElementById('vsm-dashboard-modal')?.classList.contains('active')) return;

      const combo = this.getKeyCombo(event);
      const config = this.app.storage.settings.customShortcuts[combo];

      if (config) {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        document.activeElement?.blur();
        this.executeAction(config);
      }
    }

    executeAction(config) {
      const { action, value } = config;
      const p = this.app.player;
      const e = this.app.engine;
      const step = this.app.storage.settings.microAdjustStep;

      switch (action) {
        case 'seekForward': p.currentTime(p.currentTime() + value); break;
        case 'seekBackward': p.currentTime(p.currentTime() - value); break;
        case 'togglePlay': p.paused() ? p.play() : p.pause(); break;
        case 'toggleMute': p.muted(!p.muted()); break;
        case 'toggleFullscreen': p.isFullscreen() ? p.exitFullscreen() : p.requestFullscreen(); break;
        case 'addLoopPoint': e.addPoint(); break;
        case 'toggleLoop': e.isLooping = !e.isLooping; this.app.storage.saveSceneData(); this.app.ui.refreshAll(); break;
        case 'toggleOverlayVisibility':
          this.app.storage.settings.hideUI.overlay = !this.app.storage.settings.hideUI.overlay;
          this.app.storage.saveGlobalSettings(true); // BUGFIX: Passing true prevents cloud push for purely local UI toggles
          this.app.ui.updateUIVisibility();
          if (this.app.storage.settings.hideUI.overlay && document.activeElement) document.activeElement.blur();
          break;
        case 'clearLoops': e.loopPoints = []; e.isLooping = false; this.app.storage.saveSceneData(); this.app.ui.refreshAll(); break;
        case 'splitRegion': e.splitCurrentRegion(); break;
        case 'prevRegion': e.navigateRegion(-1); break;
        case 'nextRegion': e.navigateRegion(1); break;
        case 'adjStartBack': if (e.currentRegionIdx >= 0) e.adjustRegionBound(e.currentRegionIdx, 'start', -step); break;
        case 'adjStartFwd': if (e.currentRegionIdx >= 0) e.adjustRegionBound(e.currentRegionIdx, 'start', step); break;
        case 'adjEndBack': if (e.currentRegionIdx >= 0) e.adjustRegionBound(e.currentRegionIdx, 'end', -step); break;
        case 'adjEndFwd': if (e.currentRegionIdx >= 0) e.adjustRegionBound(e.currentRegionIdx, 'end', step); break;
      }
    }

    getKeyCombo(event) {
      const parts = [];
      if (event.metaKey) parts.push('Cmd'); if (event.ctrlKey) parts.push('Ctrl');
      if (event.altKey) parts.push('Alt'); if (event.shiftKey) parts.push('Shift');
      let key = event.key; if (key === ' ') key = 'Space'; if (key.length === 1) key = key.toUpperCase();
      if (key.startsWith('Arrow')) key = 'Arrow' + key.replace('Arrow', '');
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) parts.push(key);
      return parts.join('+');
    }

    createShortcutInputs() {
      const list = document.getElementById('shortcutList');
      if (!list) return;
      list.innerHTML = window.VSM.safeHTML('');

      const actionLabels = {
        seekForward: 'Seek Forward', seekBackward: 'Seek Backward', togglePlay: 'Toggle Play/Pause', toggleMute: 'Toggle Mute',
        toggleFullscreen: 'Toggle Fullscreen', toggleLoop: 'Toggle Loop', addLoopPoint: 'Add Loop Point', toggleOverlayVisibility: 'Toggle Overlay',
        clearLoops: 'Clear Loops', splitRegion: 'Split Region', prevRegion: 'Prev Region', nextRegion: 'Next Region',
        adjStartBack: 'Adj Start Back', adjStartFwd: 'Adj Start Fwd', adjEndBack: 'Adj End Back', adjEndFwd: 'Adj End Fwd'
      };

      const grouped = {};
      Object.entries(this.app.storage.settings.customShortcuts).forEach(([key, config]) => {
        const grp = `${config.action}_${config.value || 0}`;
        if (!grouped[grp]) grouped[grp] = { action: config.action, value: config.value, keys: [] };
        grouped[grp].keys.push(key);
      });

      Object.values(grouped).forEach(group => {
        const div = document.createElement('div');
        div.style.cssText = 'margin-bottom: 5px; display: flex; align-items: center; gap: 10px; font-size:12px;';
        const name = actionLabels[group.action] || group.action;
        div.innerHTML = window.VSM.safeHTML(`<span style="min-width: 140px; font-weight:bold; color:#bbb;">${name}</span><span style="min-width: 130px; font-family:monospace; color:#00d1b2;">${group.keys.join(' | ')}</span>`);

        if (['seekForward', 'seekBackward'].includes(group.action)) {
          const valInput = document.createElement('input');
          valInput.type = 'number'; valInput.value = group.value || ''; valInput.title = 'Interval (seconds)';
          valInput.style.cssText = 'width: 50px; background: #333; color: white; border: 1px solid #555; border-radius: 3px; padding: 2px; text-align:center; outline:none;';
          valInput.addEventListener('input', (e) => {
            const newVal = parseFloat(e.target.value); if (isNaN(newVal)) return;
            group.keys.forEach(k => { if (this.app.storage.settings.customShortcuts[k]) this.app.storage.settings.customShortcuts[k].value = newVal; });
            this.app.storage.saveGlobalSettings();
          });
          div.appendChild(valInput);
        } else {
          const spacer = document.createElement('span'); spacer.style.width = '50px'; div.appendChild(spacer);
        }

        const editBtn = document.createElement('button');
        editBtn.textContent = 'Rebind'; editBtn.style.cssText = 'padding: 3px 8px; background: #2196F3; border: none; border-radius: 4px; color: white; cursor:pointer;';
        editBtn.onclick = () => this.isCapturingKey ? this.stopCapturingKey() : this.startCapturingKey(group.keys[0], editBtn);
        div.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.textContent = 'Del'; delBtn.style.cssText = 'padding: 3px 8px; background: #f44336; border: none; border-radius: 4px; color: white; cursor:pointer;';
        delBtn.onclick = () => {
          if (confirm(`Delete shortcut for ${name}?`)) {
            group.keys.forEach(k => delete this.app.storage.settings.customShortcuts[k]);
            this.app.storage.saveGlobalSettings(); this.createShortcutInputs();
          }
        };
        div.appendChild(delBtn);
        list.appendChild(div);
      });
    }

    startCapturingKey(key, btnRef) {
      this.isCapturingKey = true; this.editingKey = key; this.capturedKeys.clear();
      btnRef.textContent = 'Press keys...'; btnRef.style.background = '#FFA500';
      document.addEventListener('keydown', this.captureDown, true); document.addEventListener('keyup', this.captureUp, true);
    }

    startCapturingNewKey(action, value, btnRef) {
      this.isCapturingNewKey = true; this.newShortcutConfig = { action, value }; this.capturedKeys.clear();
      btnRef.textContent = 'Press any key...'; btnRef.style.background = '#FFA500';
      document.addEventListener('keydown', this.captureDown, true); document.addEventListener('keyup', this.captureUp, true);
    }

    stopCapturingKey() {
      this.isCapturingKey = false; this.isCapturingNewKey = false; this.editingKey = null; this.newShortcutConfig = null;
      document.removeEventListener('keydown', this.captureDown, true); document.removeEventListener('keyup', this.captureUp, true);
      const addBtn = document.getElementById('addNewShortcut');
      if (addBtn) { addBtn.textContent = 'Add Key'; addBtn.style.background = '#4CAF50'; }
      this.createShortcutInputs();
    }

    captureDown(e) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.metaKey) this.capturedKeys.add('Cmd'); if (e.ctrlKey) this.capturedKeys.add('Ctrl');
      if (e.altKey) this.capturedKeys.add('Alt'); if (e.shiftKey) this.capturedKeys.add('Shift');
      let key = e.key; if (key === ' ') key = 'Space'; if (key.length === 1) key = key.toUpperCase();
      if (key.startsWith('Arrow')) key = 'Arrow' + key.replace('Arrow', '');
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) this.capturedKeys.add(key);
      if (this.isCapturingNewKey) {
        const addBtn = document.getElementById('addNewShortcut');
        if (addBtn) addBtn.textContent = Array.from(this.capturedKeys).join('+') || 'Press any key...';
      }
    }

    captureUp(e) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const hasMainKey = Array.from(this.capturedKeys).some(k => !['Cmd', 'Ctrl', 'Alt', 'Shift'].includes(k));
      if (hasMainKey) {
        const combo = Array.from(this.capturedKeys).join('+');
        if (this.isCapturingKey) {
          const oldConf = this.app.storage.settings.customShortcuts[this.editingKey];
          delete this.app.storage.settings.customShortcuts[this.editingKey];
          this.app.storage.settings.customShortcuts[combo] = oldConf;
        } else if (this.isCapturingNewKey && this.newShortcutConfig) {
          this.app.storage.settings.customShortcuts[combo] = this.newShortcutConfig;
          const valInput = document.getElementById('newShortcutValue'); if (valInput) valInput.value = '';
        }
        this.app.storage.saveGlobalSettings(); this.stopCapturingKey();
      }
    }
  };

  // ==========================================
  // 5. CORE MODULE (UNIVERSAL ADAPTER)
  // ==========================================
  class UniversalVideoAdapter {
    constructor(videoEl) {
      this.video = videoEl; this.isDisposed_ = false;
      this.id_ = videoEl.id || 'native_video_' + Math.random().toString(36).substr(2, 9);
      this._cachedWrapper = videoEl.parentElement || videoEl;
    }
    _isValid() { return this.video && document.body.contains(this.video); }
    currentTime(val) { if (!this._isValid()) return 0; if (val !== undefined) this.video.currentTime = val; return this.video.currentTime; }
    duration() { return this._isValid() ? this.video.duration : 0; }
    paused() { return this._isValid() ? this.video.paused : true; }
    play() { return this._isValid() ? this.video.play() : Promise.resolve(); }
    pause() { if (this._isValid()) this.video.pause(); }
    muted(val) { if (!this._isValid()) return true; if (val !== undefined) this.video.muted = val; return this.video.muted; }
    volume(val) { if (!this._isValid()) return 1; if (val !== undefined) this.video.volume = val; return this.video.volume; }
    isFullscreen() { return document.fullscreenElement !== null; }
    requestFullscreen() { if (!this._isValid()) return; const container = this.el(); if (container && container.requestFullscreen) container.requestFullscreen(); }
    exitFullscreen() { if (document.exitFullscreen) document.exitFullscreen(); }
    el() { if (this._isValid()) { this._cachedWrapper = this.video.parentElement || this.video; } return this._cachedWrapper; }
    on(event, handler) { if (this._isValid()) this.video.addEventListener(event, handler); }
    off(event, handler) { if (this._isValid()) this.video.removeEventListener(event, handler); }
    one(event, handler) { if (this._isValid()) this.video.addEventListener(event, handler, { once: true }); }
    seeking() { return this._isValid() ? this.video.seeking : false; }
  }

  class VSM_Core {
    constructor() {
      window.VSM.Log.info('Core', 'Initializing Universal Tampermonkey Core v4.1.5...');
      this.player = null;
      this.lastPlayerId = null;
      this.lastSceneId = null; // Added to track URL changes
      this.storage = new window.VSM.Storage(this);
      this.engine = new window.VSM.Engine(this);
      this.ui = new window.VSM.UI(this);
      this.input = new window.VSM.Input(this);
      this.boot();
    }

    async boot() {
      await this.storage.init();
      this.ui.bindPopupEvents();
      this.input.init();
      this.startPlayerObserver();
    }

    startPlayerObserver() {
      setInterval(() => {
        const vjsEl = document.getElementById("VideoJsPlayer");
        let activePlayer = vjsEl?.player;
        if (!activePlayer) {
          const rawVideos = document.querySelectorAll('video');
          let targetVideo = null;
          for (let v of rawVideos) {
            const isGif = !v.controls && v.loop && (v.muted || v.autoplay || v.hasAttribute('playsinline'));
            const rect = v.getBoundingClientRect(); const isTiny = rect.width > 0 && (rect.width < 150 || rect.height < 150);
            if (!isGif && !isTiny && v.readyState > 0) { targetVideo = v; break; }
          }
          if (targetVideo) { if (!targetVideo.vsmAdapter) targetVideo.vsmAdapter = new UniversalVideoAdapter(targetVideo); activePlayer = targetVideo.vsmAdapter; }
        }

        // Check the URL to see if StashApp swapped videos
        const currentSceneId = this.storage.getSceneId();

        // Trigger reset if Player ID changes OR Scene ID (URL) changes
        if (activePlayer && !activePlayer.isDisposed_ &&
          (this.lastPlayerId !== activePlayer.id_ || this.lastSceneId !== currentSceneId)) {

          this.lastPlayerId = activePlayer.id_;
          this.lastSceneId = currentSceneId; // Track the new scene
          this.onPlayerReady(activePlayer);

        } else if (!activePlayer && this.lastPlayerId) {
          if (this.engine.zoomPanCleanup) this.engine.zoomPanCleanup();
          if (this.engine.videoStyleObserver) this.engine.videoStyleObserver.disconnect();
          this.lastPlayerId = null; this.player = null; this.lastSceneId = null;
        }
      }, 500);
    }

    async onPlayerReady(activePlayerInstance) {
      const vEl = activePlayerInstance.video;
      window.VSM.Log.info('Core', 'Attached to new Video Player instance.', {
        id: activePlayerInstance.id_,
        src: vEl ? vEl.src.substring(0, 50) + '...' : 'Unknown',
        dimensions: vEl ? `${vEl.videoWidth}x${vEl.videoHeight}` : 'Unknown'
      });

      this.player = activePlayerInstance;
      await this.storage.loadSceneData();

      this.player.off('timeupdate', this.engine.handleTimeUpdate);
      this.player.on('timeupdate', this.engine.handleTimeUpdate);
      ['seeked', 'play', 'pause'].forEach(ev => {
        this.player.off(ev, this.engine.applyVideoTransform);
        this.player.on(ev, this.engine.applyVideoTransform);
      });

      const videoElement = this.player.el();
      if (videoElement) {
        videoElement.addEventListener('mousedown', (e) => {
          if (!e.target.closest('button, input, select')) {
            if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) document.activeElement.blur();
          }
        });
        videoElement.removeAttribute('tabindex');
      }
      this.ui.createOverlayUI();
      this.engine.setupZoomPan();
      this.ui.refreshAll();
    }
  }

  setTimeout(() => { window.VSM_APP = new VSM_Core(); }, 100);
})();