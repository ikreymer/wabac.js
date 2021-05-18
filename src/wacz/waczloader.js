import yaml from "js-yaml";

import { MAX_FULL_DOWNLOAD_SIZE } from "../utils";
import { ZipRangeReader } from "./ziprangereader";

export const MAIN_PAGES_JSON = "pages/pages.jsonl";
export const EXTRA_PAGES_JSON = "pages/extraPages.jsonl";


// ============================================================================
export class SingleWACZLoader
{
  constructor(loader, config, loadId = null) {
    this.loader = loader;
    this.config = config;
    this.loadId = loadId;

    this.canLoadOnDemand = config.onDemand;

    this.zipreader = null;

    this.waczname = config.loadUrl;
  }

  async load(db, progressUpdate, fullTotalSize) {
    this.zipreader = db.zipreader ? db.zipreader : new ZipRangeReader(this.loader);

    const entries = await this.zipreader.load(true);

    //todo: a bit hacky, store the full arrayBuffer for blob loader
    // if size less than MAX_FULL_DOWNLOAD_SIZE
    if (this.canLoadOnDemand) {
      if (db.fullConfig && this.loader.arrayBuffer &&
        this.loader.arrayBuffer.byteLength <= MAX_FULL_DOWNLOAD_SIZE) {
        if (!db.fullConfig.extra) {
          db.fullConfig.extra = {};
        }
        db.fullConfig.extra.arrayBuffer = this.loader.arrayBuffer;
      }
    }

    await db.addWACZFile(this.waczname, entries);

    let metadata;

    if (entries["datapackage.json"]) {
      metadata = await this.loadMetadata(db, entries, "datapackage.json");
    } else if (entries["webarchive.yaml"]) {
      metadata = await this.loadMetadataYAML(db, entries, "webarchive.yaml");
    }

    if (!this.canLoadOnDemand) {
      const progressCallback = (offset) => {
        progressUpdate(Math.round(offset * 100.0 / fullTotalSize), null, offset, fullTotalSize);
        //progressUpdate(Math.round((fullCurrSize + currentSize) * 100.0 / fullTotalSize), error, fullCurrSize + currentSize, fullTotalSize, fileHandle);
      };

      await db.loadWACZ(this.waczname, false, progressCallback);
    }

    return metadata || {};
  }

  async loadTextEntry(db, filename) {
    const reader = await this.zipreader.loadFile(filename);
    const text = new TextDecoder().decode(await reader.readFully());
    return text;
  }

  // New WACZ 1.0.0 Format
  async loadMetadata(db, entries, filename) {
    const text = await this.loadTextEntry(db, filename);

    const root = JSON.parse(text);

    if (root.config !== undefined && db.initConfig) {
      db.initConfig(root.config);
    }

    const metadata = root.metadata || {};

    // All Pages
    if (entries[MAIN_PAGES_JSON]) {
      //const pageInfo = await this.loadPagesJSONL(db, MAIN_PAGES_JSON);
      const pageInfo = await db.loadPages(this.zipreader, this.waczname, MAIN_PAGES_JSON);

      if (pageInfo.hasText) {
        db.textIndex = metadata.textIndex = MAIN_PAGES_JSON;
      }
    }

    if (entries[EXTRA_PAGES_JSON]) {
      db.textIndex = metadata.textIndex = EXTRA_PAGES_JSON;
    }

    return metadata;
  }

  // Old WACZ 0.1.0 Format
  async loadMetadataYAML(db, entries, filename) {
    const text = await this.loadTextEntry(db, filename);

    const root = yaml.load(text);

    const metadata = {
      desc: root.desc,
      title: root.title
    };

    if (root.textIndex) {
      metadata.textIndex = root.textIndex;
      if (!root.config) {
        root.config = {};
      }
      root.config.textIndex = root.textIndex;
    }

    if (root.config !== undefined) {
      db.initConfig(root.config);
    }

    if (!metadata.title) {
      metadata.title = this.config.sourceName;
    }

    // All pages
    const pages = root.pages || [];

    if (pages && pages.length) {
      await db.addPages(pages);
    } else {
      if (entries["pages.csv"]) {
        await db.loadPagesCSV(db, "pages.csv");
      }
    }

    // Curated Pages
    const pageLists = root.pageLists || [];

    if (pageLists && pageLists.length) {
      await db.addCuratedPageLists(pageLists, "pages", "show");
    }

    return metadata;
  }
}

// ==========================================================================
export class JSONMultiWACZLoader
{
  constructor(json, baseUrl) {
    this.json = json;
    this.baseUrl = baseUrl;
  }

  async load(db)  {
    const metadata = {
      title: this.json.title,
      desc: this.json.description
    };

    const files = this.loadFiles(this.baseUrl);

    await db.syncWACZ(files);

    return metadata;
  }

  loadFiles() {
    return this.json.resources.map((res) => {
      return new URL(res.path, this.baseUrl).href;
    });
  }
}