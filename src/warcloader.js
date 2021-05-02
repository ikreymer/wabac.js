import { makeHeaders, Canceled, tsToDate } from "./utils.js";

import { WARCParser, postToGetUrl } from "warcio";

import { extractText } from "./extract.js";

import { BaseParser } from "./baseparser";


// ===========================================================================
class WARCLoader extends BaseParser {
  constructor(reader, abort = null, loadId = null, sourceExtra = null) {
    super();
    
    this.reader = reader;
    this.abort = abort;
    this.loadId = loadId;

    this.anyPages = false;
    this.detectPages = false;

    this._lastRecord = null;

    this.metadata = {};

    this.pageMap = {};
    this.pages = [];
    this.lists = [];

    this.source = sourceExtra;
  }

  parseWarcInfo(record) {
    if (!record.payload) {
      return;
    }
    var dec = new TextDecoder("utf-8");
    const text = dec.decode(record.payload);

    // Webrecorder-style metadata
    for (const line of text.split("\n")) {
      if (!line.startsWith("json-metadata:")) {
        continue;
      }
      
      try {
        const json = JSON.parse(line.slice("json-metadata:".length));

        if (json.type === "collection") {
          this.metadata.desc = json.desc;
          this.metadata.title = json.title;
        }

        if (json.pages && json.pages.length) {
          this.pages = this.pages.concat(json.pages);

          for (const page of json.pages) {
            page.ts = tsToDate(page.timestamp).getTime();
            this.pageMap[page.ts + "/" + page.url] = {page};
          }
          //this.promises.push(this.db.addPages(pages));
          this.anyPages = true;
        }

        if (json.lists && json.lists.length) {
          this.lists = this.lists.concat(json.lists);
        //  this.promises.push(this.db.addCuratedPageLists(lists, "bookmarks", "public"));
        }

      } catch (e) { 
        console.log("Page Add Error", e.toString());
      }
    }
  }

  index(record, parser) {
    if (record.warcType === "warcinfo") {
      this.parseWarcInfo(record);
      return;
    }

    //record.cdx = cdx;

    if (!this._lastRecord) {
      this._lastRecord = record;
      return;
    }

    if (this._lastRecord.warcTargetURI != record.warcTargetURI) {
      this.indexReqResponse(this._lastRecord, null, parser);
      this._lastRecord = record;
      return;
    }

    if (record.warcType === "request" && this._lastRecord.warcType === "response") {
      this.indexReqResponse(this._lastRecord, record, parser);
      this._lastRecord = null;
    } else if (record.warcType === "response" && this._lastRecord.warcType === "request") {
      this.indexReqResponse(record, this._lastRecord, parser);
      this._lastRecord = null;
    } else {
      this.indexReqResponse(this._lastRecord, null, parser);
      this._lastRecord = record;
    }
  }

  indexDone(parser) {
    if (this._lastRecord) {
      this.indexReqResponse(this._lastRecord, null, parser);
      this._lastRecord = null;
    }
  }

  shouldIndexMetadataRecord(record) {
    const targetURI = record.warcTargetURI;
    if (targetURI && targetURI.startsWith("metadata://")) {
      return true;
    }

    return false;
  }

  parseRevisitRecord(record) {
    const url = record.warcTargetURI.split("#")[0];
    const date = record.warcDate;
    const ts = new Date(date).getTime();

    const origURL = record.warcRefersToTargetURI;
    const origTS = new Date(record.warcRefersToDate).getTime();

    // self-revisit, skip
    if (origURL === url && origTS === ts) {
      return null;
    }

    const digest = record.warcPayloadDigest;

    return {url, ts, origURL, origTS, digest, pageId: null};
  }

  indexReqResponse(record, reqRecord) {
    const entry = this.parseRecords(record, reqRecord);

    if (entry) {
      this.addResource(entry);
    }
  }

  parseRecords(record, reqRecord) {
    switch (record.warcType) {
    case "revisit":
      return this.parseRevisitRecord(record);

    case "resource":
      reqRecord = null;
      break;

    case "response":
      break;

    case "metadata":
      if (!this.shouldIndexMetadataRecord(record)) {
        return null;
      }
      break;

    default:
      return null;
    }

    let url = record.warcTargetURI.split("#")[0];
    const date = record.warcDate;

    let headers;
    let status = 200;
    //let statusText = "OK";
    //let content = record.content;
    let cl = 0;
    let mime = "";
    let method = (reqRecord && reqRecord.httpHeaders.method);

    if (record.httpHeaders) {
      status = Number(record.httpHeaders.statusCode) || 200;

      if (method === "OPTIONS") {
        return null;
      }
 
      //statusText = record.httpHeaders.statusText;

      headers = makeHeaders(record.httpHeaders.headers);

      //if (!reqRecord && !record.content.length &&
      //    (headers.get("access-control-allow-methods") || headers.get("access-control-allow-credentials"))) {
      //  return null;
      //}

      mime = (headers.get("content-type") || "").split(";")[0];

      cl = parseInt(headers.get("content-length") || 0);

      // skip partial responses (not starting from 0)
      if (status === 206) {
        const range = headers.get("content-range");

        const fullRange = `bytes 0-${cl-1}/${cl}`;

        // only include 206 responses if they are the full range
        if (range && range !== fullRange) {
          return null;
        }
      }

      // skip self-redirects
      if (status > 300 && status < 400) {
        const location = headers.get("location");
        if (location) {
          if (new URL(location, url).href === url) {
            return null;
          }
        }
      }
    } else {
      headers = new Headers();
      headers.set("content-type", record.warcContentType);
      headers.set("content-length", record.warcContentLength);
      mime = record.warcContentType;

      cl = record.warcContentLength;
    }

    let referrer = null;

    if (reqRecord && reqRecord.httpHeaders.headers) {
      let reqHeaders = null;
      try {
        reqHeaders = new Headers(reqRecord.httpHeaders.headers);
        const cookie = reqHeaders.get("cookie");
        if (cookie) {
          headers.set("x-wabac-preset-cookie", cookie);
        }
        referrer = reqRecord.httpHeaders.headers.get("Referer");
      } catch(e) {
        reqHeaders = new Headers();
        console.warn(e);
      }

      if (method === "POST") {
        const data = {
          headers: reqHeaders,
          method,
          url,
          postData: reqRecord.payload
        };

        if (postToGetUrl(data)) {
          url = data.url;
        }
      }
    }

    // if no pages found, start detection if hasn't started already
    if (this.detectPages === undefined) {
      this.detectPages = !this.anyPages;
    }

    if (this.detectPages) {
      if (isPage(url, status, mime)) {
        const title = url;
        this.addPage({url, date, title});
      }
    }

    const ts = new Date(date).getTime();

    const respHeaders = Object.fromEntries(headers.entries());

    const digest = record.warcPayloadDigest;

    const payload = record.payload;
    const reader = payload ? null : record.reader;

    const entry = {url, ts, status, mime, respHeaders, digest, payload, reader, referrer};

    if (this.pageMap[ts + "/" + url] && payload && mime.startsWith("text/")) {
      this.pageMap[ts + "/" + url].textPromise = extractText(
        url, payload, 
        headers.get("content-encoding"),
        headers.get("transfer-encoding")
      );
    }

    const extraMetadata = record.warcHeader("WARC-JSON-Metadata");

    if (extraMetadata) {
      try {
        entry.extraOpts = JSON.parse(extraMetadata);
      } catch (e) { 
        // ignore error on extraOpts
      }
    }

    const pageId = record.warcHeader("WARC-Page-ID");

    if (pageId) {
      entry.pageId = pageId;
    }

    if (this.sourceExtra) {
      entry.source = this.sourceExtra;
    }

    return entry;
  }

  filterRecord() {
    return null;
  }

  async load(db, progressUpdate, totalSize) {
    this.db = db;

    const parser = new WARCParser(this.reader);

    let lastUpdate = 0, updateTime = 0;

    try {
      for await (const record of parser) {
        if (!record.warcType) {
          console.log("skip empty record");
          continue;
        }

        if (self.interruptLoads && this.loadId && self.interruptLoads[this.loadId]) {
          progressUpdate(Math.round((parser.offset / totalSize) * 95.0), "Loading Canceled", parser.offset, totalSize);
          self.interruptLoads[this.loadId]();
          if (this.abort) {
            this.abort.abort();
          }
          throw new Canceled();
        }

        updateTime = new Date().getTime();
        if ((updateTime - lastUpdate) > 500) {
          progressUpdate(Math.round((parser.offset / totalSize) * 95.0), null, parser.offset, totalSize);
          lastUpdate = updateTime;
        }

        const skipMode = this.filterRecord(record);
        if (skipMode === "done") {
          if (this.abort) {
            this.abort.abort();
          }
          break;
        } else if (skipMode === "skip") {
          continue;
        }

        if (skipMode === "skipContent") {
          await record.skipFully();
        } else {
          await record.readFully();
        }
        
        this.index(record, parser);

        if (this.promises.length > 0) {
          try {
            await Promise.all(this.promises);
          } catch (e) {
            console.warn(e.toString());
          }
          this.promises = [];
        }
      }
    } catch(e) {
      if (e instanceof Canceled) {
        throw e;
      }
      
      progressUpdate(Math.round((parser.offset / totalSize) * 95.0),
        `Sorry there was an error downloading. Please try again (${e})`,
        parser.offset, totalSize);

      console.warn(e);
    }

    this.indexDone(parser);

    progressUpdate(95, null, parser.offset, totalSize);

    await this.finishIndexing();

    progressUpdate(100, null, totalSize, totalSize);

    return this.metadata;
  }

  async _finishLoad() {
    if (this.pages.length) {
      for (const {page, textPromise} of Object.values(this.pageMap)) {
        if (textPromise) {
          try {
            page.text = await textPromise;
          } catch (e) {
            console.warn("Error adding text: " + e.toString());
          }
        }
      }
      this.promises.push(this.db.addPages(this.pages));
    }

    if (this.lists.length) {
      this.promises.push(this.db.addCuratedPageLists(this.lists, "bookmarks", "public"));
    }
  }
}


// ===========================================================================
function isPage(url, status, mime) {
  if (status != 200) {
    return false;
  }

  if (!url.startsWith("http:") && !url.startsWith("https:") && !url.startsWith("blob:")) {
    return false;
  }

  if (url.endsWith("/robots.txt")) {
    return false;
  }

  // skip urls with long query
  const parts = url.split("?", 2);

  if (parts.length === 2 && parts[1].length > parts[0].length) {
    return false;
  }

  // skip 'files' starting with '.' from being listed as pages
  if (parts[0].substring(parts[0].lastIndexOf("/") + 1).startsWith(".")) {
    return false;
  }

  if (mime && mime !== "text/html") {
    return false;
  }

  return true;
}


// ===========================================================================
class SingleRecordWARCLoader extends WARCLoader
{
  constructor(reader) {
    super(reader);
    this.detectPages = false;
  }

  addPage() {}

  async load() {
    const record = await new WARCParser(this.reader).parse();

    if (!record) {
      return null;
    }

    const entry = this.parseRecords(record, null);

    if (!entry || record.warcType === "revisit") {
      await record.readFully();
    }

    return entry;
  }
}


// ===========================================================================
class WARCInfoOnlyWARCLoader extends WARCLoader
{
  filterRecord(record) {
    if (record.warcType != "warcinfo") {
      return "done";
    }
  }
}

export { WARCLoader, SingleRecordWARCLoader, isPage, WARCInfoOnlyWARCLoader };
