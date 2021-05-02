//import yaml from "js-yaml";
//import { csv2jsonAsync } from "json-2-csv";
//import { WARCInfoOnlyWARCLoader, WARCLoader } from "./warcloader";
//import { CDXLoader } from "./cdxloader";

import { MAX_FULL_DOWNLOAD_SIZE } from "./utils";
import { ZipRangeReader } from "./ziprangereader";

const MAIN_PAGES_JSON = "pages/pages.jsonl";
const EXTRA_PAGES_JSON = "pages/extraPages.jsonl";


// ============================================================================
export class WACZLoader
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

    // let fullCurrSize = 0;

    // const singleEntryProgressUpdate = (percent, error, currentSize, totalSize, fileHandle = null) => {
    //   currentSize = currentSize || 0;
    //   console.log(currentSize, fullCurrSize);
    //   progressUpdate(Math.round((fullCurrSize + currentSize) * 100.0 / fullTotalSize), error, fullCurrSize + currentSize, fullTotalSize, fileHandle);
    // };

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

      //await db.saveZipEntries(entries);
      //db.db.clear("ziplines");
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

    // const indexloaders = [];

    // for (const filename of Object.keys(entries)) {
    //   const entryTotal = this.zipreader.getCompressedSize(filename);

    //   if (filename.endsWith(".cdx") || filename.endsWith(".cdxj")) {
    //     if (this.canLoadOnDemand) {
    //       // For regular cdx
    //       console.log("Loading CDX " + filename);

    //       const reader = await this.zipreader.loadFile(filename);
    //       indexloaders.push(new CDXLoader(reader).load(db));
    //     }

    //   } else if (filename.endsWith(".idx")) {
    //     if (this.canLoadOnDemand) {
    //       // For compressed indices
    //       console.log("Loading IDX " + filename);

    //       indexloaders.push(this.loadZiplinesIndex(db, filename, singleEntryProgressUpdate, entryTotal));
    //     }

    //   } else if (filename.endsWith(".warc.gz") || filename.endsWith(".warc")) {

    //     // if on-demand loading, and no metadata, load only the warcinfo records to attempt to get metadata
    //     if (!metadata && this.canLoadOnDemand) {
    //       // for WR metadata at beginning of WARCS
    //       const abort = new AbortController();
    //       const reader = await this.zipreader.loadFile(filename, {signal: abort.signal, unzip: true});
    //       const warcinfoLoader = new WARCInfoOnlyWARCLoader(reader, abort);
    //       metadata = await warcinfoLoader.load(db, singleEntryProgressUpdate, entryTotal);

    //     } else if (!this.canLoadOnDemand) {
    //       // otherwise, need to load the full WARCs
    //       const reader = await this.zipreader.loadFile(filename, {unzip: true});
    //       const warcLoader = new WARCLoader(reader);
    //       warcLoader.detectPages = false;
    //       const warcMetadata = await warcLoader.load(db, singleEntryProgressUpdate, entryTotal);
    //       if (!metadata) {
    //         metadata = warcMetadata;
    //       }
    //     }
    //   } else if (filename.endsWith(".jsonl") && filename.startsWith("pages/") && filename !== MAIN_PAGES_JSON) {
    //     await this.loadPagesJSONL(filename, false);
    //   }

    //   fullCurrSize += entryTotal;
    // }

    // await Promise.all(indexloaders);
    return metadata || {};
  }

  // async loadPagesCSV(db, filename) {
  //   const csv = await this.loadTextEntry(filename);

  //   const pages = await csv2jsonAsync(csv);

  //   if (pages && pages.length) {
  //     await db.addPages(pages);
  //   }
  // }

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
      const pageInfo = await db.loadPages(this.zipreader, this.waczname);

      if (pageInfo.hasText) {
        db.textIndex = metadata.textIndex = MAIN_PAGES_JSON;
      }
    }

    if (entries[EXTRA_PAGES_JSON]) {
      db.textIndex = metadata.textIndex = EXTRA_PAGES_JSON;
    }

    return metadata;
  }

  /*
  async loadPagesJSONL(db, filename, isMainPages = true) {
    const PAGE_BATCH_SIZE = 500;

    const reader = await this.zipreader.loadFile(filename, {unzip: true});

    let pageListInfo = null;

    let pages = [];

    for await (const textLine of reader.iterLines()) {
      const page = JSON.parse(textLine);

      if (!pageListInfo) {
        pageListInfo = page;
        continue;
      }

      pages.push(page);

      if (pages.length === PAGE_BATCH_SIZE) {
        if (isMainPages) {
          await db.addPages(pages);
        } else {
          await db.addCuratedPageList(pageListInfo, pages);
        }
        pages = [];
      }
    }

    if (pages.length) {
      if (isMainPages) {
        await db.addPages(pages);
      } else {
        await db.addCuratedPageList(pageListInfo, pages);
      }
    }

    return pageListInfo;
  }
*/
  // Old WACZ 0.1.0 Format
  /*
  async loadMetadataYAML(db, entries, filename) {
    const text = await this.loadTextEntry(db, filename);

    const root = yaml.safeLoad(text);

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
  }*/

  /*
  async loadZiplinesIndex(db, filename, progressUpdate, totalSize) {
    const reader = await this.zipreader.loadFile(filename);

    let currOffset = 0;

    let lastUpdate = 0, updateTime = 0;

    let batch = [];
    let defaultFilename = "";
    
    for await (const line of reader.iterLines()) {
      currOffset += line.length;

      if (currOffset === line.length) {
        if (line.startsWith("!meta")) {
          const inx = line.indexOf(" {");
          if (inx < 0) {
            console.warn("Invalid Meta Line: " + line);
            continue;
          }

          const indexMetadata = JSON.parse(line.slice(inx));
          
          if (indexMetadata.filename) {
            defaultFilename = indexMetadata.filename;
          }
          if (indexMetadata.format !== "cdxj-gzip-1.0") {
            console.log(`Unknown CDXJ format "${indexMetadata.format}", archive may not parse correctly`);
          }
          continue;
        }
      }

      let entry;

      if (line.indexOf("\t") > 0) {

        let [prefix, filename, offset, length] = line.split("\t");
        offset = Number(offset);
        length = Number(length);

        entry = {prefix, filename, offset, length, loaded: false};

        db.useSurt = true;

      } else {
        const inx = line.indexOf(" {");
        if (inx < 0) {
          console.log("Invalid Index Line: " + line);
          continue;
        }
        const prefix = line.slice(0, inx);
        let {offset, length, filename} = JSON.parse(line.slice(inx));

        db.useSurt = prefix.indexOf(")/") > 0;

        filename = filename || defaultFilename;

        entry = {prefix, filename, offset, length, loaded: false};

      }

      updateTime = new Date().getTime();
      if ((updateTime - lastUpdate) > 500) {
        progressUpdate(Math.round((currOffset / totalSize) * 100.0), null, currOffset, totalSize);
        lastUpdate = updateTime;
      }

      batch.push(entry);
    }

    db.addZipLines(batch);

    if (db.useSurt) {
      this.config.useSurt = db.useSurt;
    }
  }
  */
}
