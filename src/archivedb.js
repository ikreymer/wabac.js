"use strict";

import { openDB, deleteDB } from "idb/with-async-ittr.js";
import { tsToDate, isNullBodyStatus, makeHeaders, digestMessage,
  getTS, getStatusText, randomId, PAGE_STATE_SYNCED } from "./utils";
import { fuzzyMatcher } from "./fuzzymatcher";
import { ArchiveResponse } from "./response";


const MAX_FUZZY_MATCH = 128000;
const MAX_RESULTS = 16;
const MAX_DATE_TS = new Date("9999-01-01").getTime();

const REVISIT = "warc/revisit";

// ===========================================================================
class ArchiveDB {
  constructor(name, opts = {}) {
    this.name = name;
    this.db = null;

    const { minDedupSize, noRefCounts } = opts;
    this.minDedupSize = Number.isInteger(minDedupSize) ? minDedupSize : 1024;

    this.version = 3;

    this.autoHttpsCheck = true;
    this.useRefCounts = !noRefCounts;

    this.allowRepeats = true;
    this.repeatTracker = this.allowRepeats ? new RepeatTracker() : null;
    this.fuzzyPrefixSearch = true;

    this.initing = this.init();
  }

  async init() {
    let oldVersion = 0;

    this.db = await openDB(this.name, this.version, {
      upgrade: (db, oldV, newV, tx) => {
        oldVersion = oldV;
        this._initDB(db, oldV, newV, tx);
      },
      blocking: (e) => { if (!e || e.newVersion === null) { this.close(); }}
    });

    if (oldVersion === 1) {
      await this.convertCuratedPagesToV2(this.db);
    }
  }

  _initDB(db, oldV/*, newV, tx*/) {
    if (!oldV) {
      const pageStore = db.createObjectStore("pages", { keyPath: "id" });
      pageStore.createIndex("url", "url");
      pageStore.createIndex("ts", "ts");
      pageStore.createIndex("state", "state");

      db.createObjectStore("pageLists", { keyPath: "id", autoIncrement: true});

      const curatedPages = db.createObjectStore("curatedPages", { keyPath: "id", autoIncrement: true});
      curatedPages.createIndex("listPages", ["list", "pos"]);

      const urlStore = db.createObjectStore("resources", { keyPath: ["url", "ts"] });
      urlStore.createIndex("pageId", "pageId");
      //urlStore.createIndex("pageUrlTs", ["pageId", "url", "ts"]);
      //urlStore.createIndex("ts", "ts");
      urlStore.createIndex("mimeStatusUrl", ["mime", "status", "url"]);

      db.createObjectStore("payload", { keyPath: "digest", unique: true});
      db.createObjectStore("digestRef", { keyPath: "digest", unique: true});
    }
  }

  async clearAll() {
    const stores = ["pages", "resources", "payload", "digestRef"];

    for (const store of stores) {
      await this.db.clear(store);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async delete() {
    this.close();
    await deleteDB(this.name, {
      blocked(reason) {
        console.log("Unable to delete: " + reason);
      }
    });
  }

  async addPage(page, tx) {
    const url = page.url;
    const title = page.title || page.url;
    const id = page.id || this.newPageId();
    const state = page.state || PAGE_STATE_SYNCED;
    let ts = page.ts;


    if (typeof(ts) !== "number") {
      if (page.timestamp) {
        ts = tsToDate(page.timestamp).getTime();
      } else {
        const date = page.ts || page.date || page.datetime;
        if (date) {
          ts = new Date(date).getTime();
        }
      }
    }

    const p = {...page, url, ts, title, id, state};

    if (tx) {
      tx.store.put(p);
      return p.id;
    } else {
      return await this.db.put("pages", p);
    }
  }

  async addPages(pages, pagesTable = "pages", update = false) {
    const tx = this.db.transaction(pagesTable, "readwrite");

    for (const page of pages) {
      if (update) {
        tx.store.put(page);
      } else {
        this.addPage(page, tx);
      }
    }

    try {
      await tx.done;
    } catch(e) {
      console.warn("addPages tx", e.toString());
    }
  }

  async createPageList(data) {
    const listData = {};
    listData.title = data.title;
    listData.desc = data.desc || data.description;
    listData.slug = data.id || data.slug;

    return await this.db.put("pageLists", listData);
  }

  async addCuratedPageList(listInfo, pages) {
    const listId = await this.createPageList(listInfo);

    let pos = 0;

    for (const page of pages) {
      page.pos = pos++;
      page.list = listId;
    }

    await this.addPages(pages, "curatedPages");
  }

  async addCuratedPageLists(pageLists, pageKey = "pages", filter = "public") {
    for (const list of pageLists) {
      if (filter && !list[filter]) {
        continue;
      }

      const pages = list[pageKey] || [];

      await this.addCuratedPageList(list, pages);
    }
  }

  async convertCuratedPagesToV2(db) {
    const curatedPages = await db.getAll("curatedPages");

    if (!curatedPages || !curatedPages.length) {
      return;
    }

    const pages = await db.getAll("pages");
    const pageMap = new Map();

    for (const page of pages) {
      pageMap.set(page.id, page);
    }

    for (const cpage of curatedPages) {
      if (cpage.page) {
        const page = pageMap.get(cpage.page);
        if (page) {
          cpage.id = this.newPageId();
          cpage.url = page.url;
          cpage.ts = page.ts;
          if (!cpage.title && page.title) {
            cpage.title = page.title;
          }
        }
        delete cpage.page;
      }
    }

    await db.clear("curatedPages");

    const tx = db.transaction("curatedPages", "readwrite");

    for (const cpage of curatedPages) {
      tx.store.put(cpage);
    }

    try {
      await tx.done;
    } catch (e) {
      console.warn("Conversion Failed", e);
    }
  }

  async getCuratedPagesByList() {
    const allLists = await this.db.getAll("pageLists");

    const tx = this.db.transaction("curatedPages", "readonly");

    for await (const cursor of tx.store.index("listPages").iterate()) {
      const list = allLists[cursor.value.list - 1];
      if (!list) {
        continue;
      }
      list.show = true;
      if (!list.pages) {
        list.pages = [];
      }
      list.pages.push(cursor.value);
    }

    return allLists;
  }

  newPageId() {
    return randomId();
  }

  async getAllPages() {
    return await this.db.getAll("pages");
  }

  async getPages(pages) {
    const results = [];
    pages.sort();

    for await (const result of this.matchAny("pages", null, pages)) {
      results.push(result);
    }

    return results;
  }

  async getPagesWithState(state) {
    return await this.db.getAllFromIndex("pages", "state", state);
  }

  async dedupResource(digest, payload, tx, count = 1) {
    const digestRefStore = tx.objectStore("digestRef");
    const ref = await digestRefStore.get(digest);

    if (ref) {
      ++ref.count;
      return ref;
      //digestRefStore.put(ref);
      //return ref.count;

    } else if (payload) {
      try {
        tx.objectStore("payload").put({digest, payload});
        const size = payload.length;
        //digestRefStore.put({digest, count, size});
        return {digest, count, size};
      } catch (e) {
        console.log(e);
      }
    }

    return null;
  }

  async addResources(datas) {
    const revisits = [];
    const regulars = [];

    const digestRefCount = {};
    const changedDigests = new Set();

    const dtx = this.db.transaction(["digestRef", "payload"], "readwrite");

    for (const data of datas) {
      let refCount = 1;

      const array = data.mime === REVISIT ? revisits : regulars;

      array.push(data);

      const fuzzyUrlData = this.getFuzzyUrl(data);

      if (fuzzyUrlData) {
        array.push(fuzzyUrlData);
        refCount = 2;
      }

      if (this.useRefCounts && data.digest) {
        if (!digestRefCount[data.digest]) {
          digestRefCount[data.digest] = await this.dedupResource(data.digest, data.payload, dtx, refCount);
        } else {
          digestRefCount[data.digest].count += refCount;
          changedDigests.add(data.digest);
        }
        delete data.payload;
      }
    }

    if (this.useRefCounts) {
      const digestRefStore = dtx.objectStore("digestRef");

      for (const digest of changedDigests) {
        digestRefStore.put(digestRefCount[digest]);
      }
    }

    try {
      await dtx.done;
    } catch(e) {
      console.error("Payload and Ref Count Bulk Add Failed: ", e);
    }

    const tx = this.db.transaction("resources", "readwrite");

    for (const data of revisits) {
      tx.store.put(data);
    }

    for (const data of regulars) {
      tx.store.put(data);
    }

    try {
      await tx.done;
    } catch (e) {
      console.error("Resources Bulk Add Failed", e);
    }
  }

  getFuzzyUrl(result) {
    if (result.status >= 200 && result.status < 400 && result.status !== 304 && result.status !== 204) {
      const {fuzzyCanonUrl} = fuzzyMatcher.getRuleFor(result.url);

      if (!fuzzyCanonUrl || fuzzyCanonUrl === result.url) {
        return null;
      }

      const fuzzyRes = {
        url: fuzzyCanonUrl,
        ts: result.ts,
        origURL: result.url,
        origTS: result.ts,
        pageId: result.pageId,
        digest: result.digest
      };

      return fuzzyRes;
    }

    return null;
  }

  async addResource(data) {
    if (data.payload && data.payload.length > this.minDedupSize) {
      if (!data.digest) {
        data.digest = await digestMessage(data.payload, "sha-256");
      }
    }

    let digestRefCount = null;
    let isNew = false;

    const tx = this.db.transaction(["resources", "digestRef", "payload"], "readwrite");

    if (data.payload && data.payload.length > this.minDedupSize) {
      digestRefCount = await this.dedupResource(data.digest, data.payload, tx);
      isNew = (digestRefCount && digestRefCount.count === 1);
      delete data.payload;
    } else if (data.payload) {
      isNew = true;
    }

    if (data.mime !== REVISIT) {
      tx.objectStore("resources").put(data);

      const fuzzyUrlData = this.getFuzzyUrl(data);

      if (fuzzyUrlData) {
        tx.objectStore("resources").put(fuzzyUrlData);
        if (digestRefCount) {
          digestRefCount.count++;
        }
      }
    } else {
      // using add() to allow failing if non-revisit already exists
      tx.objectStore("resources").add(data);
    }

    if (digestRefCount) {
      tx.objectStore("digestRef").put(digestRefCount);
    }

    try {
      await tx.done;
    } catch (e) {
      if (data.mime === REVISIT) {
        console.log("Skip Duplicate revisit for: " + data.url);
      } else {
        console.log("Add Error for " + data.url);
      }
      console.log(e);
    }

    return isNew;
  }

  async getResource(request, rwPrefix, event, opts = {}) {
    const ts = tsToDate(request.timestamp).getTime();
    let url = request.url;

    let result = null;

    const skip = this.repeatTracker ? this.repeatTracker.getSkipCount(event, url, request.request.method) : 0;
    const newOpts = {...opts, skip};

    if (url.startsWith("//")) {
      let useHttp = false;
      result = await this.lookupUrl("https:" + url, ts, newOpts);
      if (!result) {
        result = await this.lookupUrl("http:" + url, ts, newOpts);
        // use http if found or if referrer contains an http replay path
        // otherwise, default to https
        if (result || request.request.referrer.indexOf("/http://", 2) > 0) {
          useHttp = true;
        }
      }
      url = (useHttp ? "http:" : "https:") + url;
    } else {
      result = await this.lookupUrl(url, ts, newOpts);
      if (!result && this.autoHttpsCheck && url.startsWith("http://")) {
        const httpsUrl = url.replace("http://", "https://");
        result = await this.lookupUrl(httpsUrl, ts, newOpts);
        if (result) {
          url = httpsUrl;
        }
      }
    }

    if (!result && this.fuzzyPrefixSearch) {
      result = await this.lookupQueryPrefix(url, opts);
    }

    // check if redirect
    if (result && result.origURL) {
      const origResult = await this.lookupUrl(result.origURL, result.origTS || result.ts, opts);
      if (origResult) {
        url = origResult.url;
        result = origResult;
      }
    }

    if (!result) {
      return null;
    }

    const status = result.status;
    const statusText = result.statusText || getStatusText(status);

    let payload = null;

    if (!isNullBodyStatus()) {
      payload = await this.loadPayload(result, opts);
      if (!payload) {
        return null;
      }
    }

    const headers = makeHeaders(result.respHeaders);

    const date = new Date(result.ts);

    const extraOpts = result.extraOpts || null;

    url = result.url;

    return new ArchiveResponse({url, payload, status, statusText, headers, date, extraOpts});
  }

  async loadPayload(result/*, opts*/) {
    if (result.digest && !result.payload) {
      const payloadRes = await this.db.get("payload", result.digest);
      if (!payloadRes) {
        return null;
      }
      const { payload } = payloadRes;
      return payload;
    }

    return result.payload;
  }

  async lookupUrl(url, ts, opts = {}) {
    const tx = this.db.transaction("resources", "readonly");

    if (ts) {
      const range = IDBKeyRange.bound([url, ts], [url, MAX_DATE_TS]);

      if (!opts.noRevisits && !opts.pageId) {
        const result = await tx.store.get(range);
        if (result) {
          return result;
        }
      } else {
        let results = await tx.store.getAll(range, MAX_RESULTS);
        results = results || [];

        for (const result of results) {
          if (opts.pageId && result.pageId && (result.pageId !== opts.pageId)) {
            continue;
          }

          if (opts.noRevisits && result.mime === REVISIT) {
            continue;
          }

          return result;
        }
      }
    } 

    // search reverse from ts (or from latest capture)
    const range = IDBKeyRange.bound([url], [url, ts || MAX_DATE_TS]);

    for await (const cursor of tx.store.iterate(range, "prev")) {
      const result = cursor.value;

      if (opts.pageId && result.pageId && (result.pageId !== opts.pageId)) {
        continue;
      }

      if (opts.noRevisits && result.mime === REVISIT) {
        continue;
      }

      return result;
    }

    return null;
  }

  async lookupQueryPrefix(url, opts) {
    const {rule, prefix, fuzzyCanonUrl/*, fuzzyPrefix*/} = fuzzyMatcher.getRuleFor(url);

    if (fuzzyCanonUrl !== url) {
      const result = await this.lookupUrl(fuzzyCanonUrl, 0, opts);
      if (result) {
        return result;
      }

      //const results = await this.db.getAll("resources", this.getLookupRange(fuzzyPrefix, "prefix"));
      //return fuzzyMatcher.fuzzyCompareUrls(url, results, rule);
    }

    // only do fuzzy prefix match for custom rules that have a query
    if (!rule && prefix === url && prefix === fuzzyCanonUrl && !url.endsWith("?")) {
      return null;
    }

    //todo: explore optimizing with incremental loading?
    const results = await this.db.getAll("resources", this.getLookupRange(prefix, "prefix"), MAX_FUZZY_MATCH);

    return fuzzyMatcher.fuzzyCompareUrls(url, results, rule);
  }

  resJson(res) {
    const date = new Date(res.ts).toISOString();
    return {
      url: res.url,
      date: date,
      ts: getTS(date),
      mime: res.mime,
      status: res.status
    };
  }

  async resourcesByPage(pageId) {
    return this.db.getAllFromIndex("resources", "pageId", pageId);
  }

  async* resourcesByPages2(pageIds) {
    pageIds.sort();

    yield* this.matchAny("resources", "pageId", pageIds);
  }

  async* resourcesByPages(pageIds) {
    const tx = this.db.transaction("resources", "readonly");

    for await (const cursor of tx.store.iterate()) {
      if (pageIds.includes(cursor.value.pageId)) {
        yield cursor.value;
      }
    }
  }

  async* matchAny(storeName, indexName, sortedKeys, subKey, openBound = false) {
    const tx = this.db.transaction(storeName, "readonly");

    const range = IDBKeyRange.lowerBound(sortedKeys[0], openBound);

    let cursor = indexName ? await tx.store.index(indexName).openCursor(range) : await tx.store.openCursor(range);

    let i = 0;

    while (cursor && i < sortedKeys.length) {
      let currKey, matchKey, matches;

      if (subKey !== undefined) {
        currKey = cursor.key[subKey];
        matchKey = sortedKeys[i][subKey];
        matches = currKey.startsWith(matchKey);
      } else {
        currKey = cursor.key;
        matchKey = sortedKeys[i];
        matches = currKey === matchKey;
      }

      if (!matches && currKey > matchKey) {
        ++i;
        continue;
      }

      if (matches) {
        yield cursor.value;
        cursor = await cursor.continue();
      } else {
        cursor = await cursor.continue(sortedKeys[i]);
      }
    }
  }

  async resourcesByUrlAndMime(url, mimes, count = 1000, prefix = true, fromUrl = "", fromTs = "") {
    // if doing local mime filtering, need to remove count
    const queryCount = mimes ? null : count;

    const fullResults = await this.db.getAll("resources",
      this.getLookupRange(url, prefix ? "prefix" : "exact", fromUrl, fromTs), queryCount);

    mimes = mimes.split(",");
    const results = [];

    for (const res of fullResults) {
      for (const mime of mimes) {
        if (!mime || (res.mime && res.mime.startsWith(mime))) {
          results.push(this.resJson(res));
          if (results.length === count) {
            return results;
          }
          break;
        }
      }
    }

    return results;
  }

  async resourcesByMime(mimes, count = 100, fromMime = "", fromUrl = "", fromStatus = 0) {
    mimes = mimes.split(",");
    const results = [];

    mimes.sort();

    let startKey = [];

    if (fromMime) {
      startKey.push([fromMime, fromStatus, fromUrl]);
    }

    for (const mime of mimes) {
      if (!fromMime || !mime || mime > fromMime) {
        startKey.push([mime, 0, ""]);
      }
    }

    for await (const result of this.matchAny("resources", "mimeStatusUrl", startKey, 0, true)) {
      results.push(this.resJson(result));

      if (results.length === count) {
        break;
      }
    }

    return results;
    /*
    let i = 0;
    let cursor = await this.db.transaction("resources").store.index("mimeStatusUrl").openCursor();

    while (cursor && i < startKey.length) {
      const mime = cursor.key[0];

      const matches = mime.startsWith(startKey[i][0]);

      if (!matches && mime > startKey[i][0]) {
        ++i;
        continue;
      }

      if (matches) {
        results.push(this.resJson(cursor.value));
        cursor = await cursor.continue();
      } else {
        cursor = await cursor.continue(startKey[i]);
      }
    }
*/
  }

  async deletePage(id) {
    const tx = this.db.transaction("pages", "readwrite");
    const page = await tx.store.get(id);
    await tx.store.delete(id);

    const size = await this.deletePageResources(id);
    return {pageSize: page && page.size || 0,
      dedupSize: size};
  }

  async deletePageResources(pageId) {
    const digestSet = {};

    const tx = this.db.transaction("resources", "readwrite");

    let cursor = await tx.store.index("pageId").openCursor(pageId);

    let size = 0;

    while (cursor) {
      const digest = cursor.value.digest;
      if (digest) {
        digestSet[digest] = (digestSet[digest] || 0) + 1;
      } else if (cursor.value.payload) {
        size += cursor.value.payload.length;
      }

      tx.store.delete(cursor.primaryKey);

      cursor = await cursor.continue();
    }

    await tx.done;

    // delete payloads
    const tx2 = this.db.transaction(["payload", "digestRef"], "readwrite");
    const digestRefStore = tx2.objectStore("digestRef");

    for (const digest of Object.keys(digestSet)) {
      const ref = await digestRefStore.get(digest);

      if (ref) {
        ref.count -= digestSet[digest];
      }

      if (ref && ref.count >= 1) {
        digestRefStore.put(ref);
      } else {
        size += ref ? ref.size : 0;
        digestRefStore.delete(digest);
        tx2.objectStore("payload").delete(digest);
      }
    }

    await tx2.done;
    return size;
  }

  getLookupRange(url, type, fromUrl, fromTs) {
    let lower;
    let upper;

    switch (type) {
    case "prefix":
      lower = [url];
      upper = [url.slice(0, -1) + String.fromCharCode(url.charCodeAt(url.length - 1) + 1)];
      break;

    case "host": {
      const origin = new URL(url).origin;
      lower = [origin + "/"];
      upper = [origin + "0"];
      break;
    }

    case "exact":
    default:
      lower = [url];
      //upper = [url + "!"];
      upper = [url, Number.MAX_SAFE_INTEGER];
    }

    let exclusive;

    if (fromUrl) {
      lower = [fromUrl, fromTs || ""];
      exclusive = true;
    } else {
      exclusive = false;
    }

    return IDBKeyRange.bound(lower, upper, exclusive, true);
  }
}

// ===========================================================================
class RepeatTracker {
  constructor() {
    this.repeats = {};
  }

  getSkipCount(event, url, method) {
    if (method !== "POST" && !url.endsWith(".m3u8")) {
      return 0;
    }

    if (event.replacesClientId) {
      delete this.repeats[event.replacesClientId];
    }

    const id = event.resultingClientId || event.clientId;
    if (!id) {
      return 0;
    }

    if (this.repeats[id] === undefined) {
      this.repeats[id] = {};
    }

    if (this.repeats[id][url] === undefined) {
      this.repeats[id][url] = 0;
    } else {
      this.repeats[id][url]++;
    }

    return this.repeats[id][url];
  }
}


export { ArchiveDB };


