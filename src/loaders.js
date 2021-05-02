import { ArchiveDB } from "./archivedb.js";
import { RemoteSourceArchiveDB, RemotePrefixArchiveDB } from "./remotearchivedb";
//import { WACZRemoteArchiveDB } from "./waczarchive";

//import { HARLoader } from "./harloader";
//import { WBNLoader } from "./wbnloader";
import { WARCLoader } from "./warcloader";
import { CDXLoader, CDXFromWARCLoader } from "./cdxloader";

import { createLoader } from "./blockloaders";

import { RemoteWARCProxy, RemoteProxySource, LiveAccess } from "./remoteproxy";

import { deleteDB, openDB } from "idb/with-async-ittr.js";
import { Canceled, MAX_FULL_DOWNLOAD_SIZE, randomId, AuthNeededError } from "./utils.js";
import { WACZLoader } from "./waczloader.js";

import { JSONMultiWACZLoader, MultiWACZCollection, SingleWACZ } from "./multiwacz.js";

self.interruptLoads = {};


// ===========================================================================
class CollectionLoader
{
  constructor() {
    this.colldb = null;
    this.root = null;
    this.checkIpfs = true;
    this._init_db = this._initDB();
  }

  async _initDB() {
    this.colldb = await openDB("collDB", 1, {
      upgrade: (db/*, oldV, newV, tx*/) => {
        const collstore = db.createObjectStore("colls", {keyPath: "name"});

        collstore.createIndex("type", "type");
      }
    });
  }

  async loadAll(dbColls) {
    await this._init_db;

    if (dbColls) {
      for (const extraColl of dbColls.split(",")) {
        const parts = extraColl.split(":");
        if (parts.length === 2) {
          const config = {dbname: parts[1], sourceName: parts[1], decode: false};
          const collData = {name: parts[0], type: "archive", config};
          console.log("Adding Coll: " + JSON.stringify(collData));
          await this.colldb.put("colls", collData);
        }
      }
    }

    try {
      const allColls = await this.listAll();

      const promises = allColls.map((data) => this._initColl(data));
  
      await Promise.all(promises);
    } catch (e) {
      console.warn(e.toString());
    }

    return true;
  }

  async listAll() {
    await this._init_db;
    return await this.colldb.getAll("colls");
  }

  async loadColl(name) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return null;
    }

    return await this._initColl(data);
  }

  async deleteColl(name) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }

    if (data.config.dbname) {
      try {
        await deleteDB(data.config.dbname, {
          blocked() {
            console.log(`Unable to delete ${data.config.dbname}, blocked`);
          }
        });
      } catch(e) {
        console.warn(e);
        return false;
      }
    }

    await this.colldb.delete("colls", name);

    return true;
  }

  async updateAuth(name, newHeaders) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }
    data.config.headers = newHeaders;
    await this.colldb.put("colls", data);
    return true;
  }

  async updateMetadata(name, newMetadata) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }
    data.config.metadata = {...data.config.metadata, ...newMetadata};

    await this.colldb.put("colls", data);
    return data.config.metadata;
  }

  async updateSize(name, fullSize, dedupSize) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }

    const metadata = data.config.metadata;
    metadata.fullSize = (metadata.fullSize || 0) + fullSize;
    metadata.size = (metadata.size || 0) + dedupSize;
    metadata.mtime = new Date().getTime();
    await this.colldb.put("colls", data);
  }

  async initNewColl(metadata, extraConfig = {}, type = "archive") {
    await this._init_db;
    const id = randomId();
    const dbname = "db:" + id;
    const sourceUrl = "local://" + id;
    const decode = false;
    const ctime = new Date().getTime();

    const data = {
      name: id,
      type,
      config: {
        dbname,
        ctime,
        decode,
        metadata,
        sourceUrl,
        extraConfig,
      }
    };

    const coll = await this._initColl(data);
    await this.colldb.put("colls", data);
    return coll;
  }

  async _initColl(data) {
    const store = await this._initStore(data.type, data.config);

    const name = data.name;
    const config = data.config;

    if (data.config.root) {
      this.root = name;
    }

    return this._createCollection({name, store, config});
  }

  async _initStore(type, config) {
    let sourceLoader = null;
    let store = null;

    switch (type) {
    case "archive":
      store = new ArchiveDB(config.dbname);
      break;

    case "remotesource":
      sourceLoader = createLoader({
        url: config.loadUrl,
        headers: config.headers,
        size: config.size,
        extra: config.extra
      });
      store = new RemoteSourceArchiveDB(config.dbname, sourceLoader, config.noCache);
      break;

    case "remoteprefix":
      store = new RemotePrefixArchiveDB(config.dbname, config.remotePrefix, config.headers, config.noCache);
      break;        

    case "remotezip":
      sourceLoader = createLoader({
        url: config.loadUrl || config.sourceUrl,
        headers: config.headers,
        extra: config.extra
      });
      //store = new WACZRemoteArchiveDB(config.dbname, sourceLoader, config);
      store = new SingleWACZ(config, sourceLoader);
      break;

    case "remoteproxy":
      //TODO remove?
      store = new RemoteProxySource(config);
      break;

    case "remotewarcproxy":
      store = new RemoteWARCProxy(config);
      break;

    case "live":
      store = new LiveAccess(config);
      break;

    case "multiwacz":
      store = new MultiWACZCollection(config);
    }

    if (!store) {
      console.log("no store found: " + type);
      return null;
    }

    if (store.initing) {
      await store.initing;
    }

    return store;
  }

  _createCollection(opts) {
    return opts;
  }
}

// ===========================================================================
class WorkerLoader extends CollectionLoader
{
  constructor(worker) {
    super();
    this.registerListener(worker);
  }

  async hasCollection(name) {
    await this._init_db;

    return await this.colldb.getKey("colls", name) != null;
  }

  registerListener(worker) {
    worker.addEventListener("message", event => event.waitUntil(this._handleMessage(event)));
  }

  async _handleMessage(event) {
    await this._init_db;

    const client = event.source || self;

    switch (event.data.msg_type) {
    case "addColl":
    {
      const name = event.data.name; 

      const progressUpdate = (percent, error, currentSize, totalSize, fileHandle = null) => {
        client.postMessage({
          "msg_type": "collProgress",
          name,
          percent,
          error,
          currentSize,
          totalSize,
          fileHandle
        });
      };

      let res;

      try {
        res = await this.colldb.get("colls", name);
        if (res) {
          if (!event.data.skipExisting) {
            await this.deleteColl(name);
            res = await this.addCollection(event.data, progressUpdate);
          }
        } else {
          res = await this.addCollection(event.data, progressUpdate);
        }
  
        if (!res) {
          if (event.data.name) {
            try {
              await deleteDB("db:" + event.data.name, {
                blocked(reason) {
                  console.log(`Load failed and unable to delete ${event.data.name}: ${reason}`);
                }
              });
            } catch (e) {
              console.warn(e);
            }
          }
          return;
        }

      } catch (e) {
        console.warn(e);
        if (e instanceof AuthNeededError) {
          progressUpdate(0, "permission_needed", null, null, e.info && e.info.fileHandle);
        } else {
          progressUpdate(0, "An unexpected error occured: " + e.toString());
        }
        return;
      }

      client.postMessage({
        msg_type: "collAdded",
        name,
        sourceUrl: res.config.sourceUrl
      });

      //this.doListAll(client);
      break;
    }

    case "cancelLoad":
    {
      const name = event.data.name;

      const p = new Promise((resolve) => self.interruptLoads[name] = resolve);

      await p;

      await this.deleteColl(name);

      delete self.interruptLoads[name];

      break;
    }

    case "removeColl":
    {
      const name = event.data.name;

      if (await this.hasCollection(name)) {
        await this.deleteColl(name);
        this.doListAll(client);
      }
      break;
    }

    case "listAll":
      this.doListAll(client);
      break;
    }
  }

  async doListAll(client) {
    const msgData = [];
    const allColls = await this.listAll();

    for (const coll of allColls) {

      //const pageList = await coll.store.getAllPages();
  
      msgData.push({
        "name": coll.name,
        "prefix": coll.name,
        "pageList": [],
        "sourceName": coll.config.sourceName
      });
    }
    client.postMessage({ "msg_type": "listAll", "colls": msgData });
  }
  
  async addCollection(data, progressUpdate) {
    let name = data.name;

    let type = null;
    let config = {root: data.root || false};
    let db = null;

    const file = data.file;

    if (!file || !file.sourceUrl) {
      progressUpdate(0, "Invalid Load Request");
      return false;
    }

    if (file.sourceUrl.startsWith("proxy:")) {
      config.sourceUrl = file.sourceUrl.slice("proxy:".length);
      config.extraConfig = data.extraConfig;
      config.topTemplateUrl = data.topTemplateUrl;
      type = data.type || "remotewarcproxy";

      db = await this._initStore(type, config);

    } else {
      let loader = null;

      if (file.newFullImport) {
        name = randomId();
        file.loadUrl = file.loadUrl || file.sourceUrl;
        file.name = file.name || file.sourceUrl;
        file.sourceUrl = "local://" + name;
      }

      type = "archive";
      config.dbname = "db:" + name;

      let loadUrl = file.loadUrl || file.sourceUrl;

      if (!loadUrl.match(/[\w]+:\/\//)) {
        loadUrl = new URL(loadUrl, self.location.href).href;
      }

      config.decode = true;
      config.onDemand = false;
      config.loadUrl = loadUrl;
      config.sourceUrl = file.sourceUrl;

      config.sourceName = file.name || file.sourceUrl;

      // parse to strip out query and fragment
      try {
        if (config.sourceName.match(/https?:\/\//)) {
          config.sourceName = new URL(config.sourceName).pathname;
        }
      } catch (e) {
        // ignore, keep sourceName as is
      }
      config.sourceName = config.sourceName.slice(config.sourceName.lastIndexOf("/") + 1);

      config.headers = file.headers;
      config.size = typeof(file.size) === "number" ? file.size : null;
      config.extra = file.extra;

      if (config.loadUrl.startsWith("file://") && !file.blob && !config.extra) {
        if (this._fileHandles && this._fileHandles[config.sourceUrl]) {
          config.extra = {fileHandle: this._fileHandles[config.sourceUrl]};
        } else {
          progressUpdate(0, "missing_local_file");
          return;
        }
      }

      config.extraConfig = data.extraConfig;
      config.noCache = file.noCache;

      const sourceLoader = createLoader({
        url: loadUrl,
        headers: file.headers,
        size: file.size,
        extra: config.extra,
        blob: file.blob
      });

      let tryHeadOnly = false;

      if (config.sourceName.endsWith(".wacz") || config.sourceName.endsWith(".zip")) {
        // do HEAD request only
        tryHeadOnly = true;
      }
      
      let {abort, response} = await sourceLoader.doInitialFetch(tryHeadOnly);
      const stream = response.body;

      config.onDemand = sourceLoader.canLoadOnDemand && !file.newFullImport;

      if (!sourceLoader.isValid) {
        const text = sourceLoader.length <= 1000 ? await response.text() : "";
        progressUpdate(0, `\
Sorry, this URL could not be loaded.
Make sure this is a valid URL and you have access to this file.
Status: ${response.status} ${response.statusText}
Error Details:
${text}`);
        if (abort) {
          abort.abort();
        }
        return false;
      }

      if (!sourceLoader.length) {
        progressUpdate(0, `\
Sorry, this URL could not be loaded because the size of the file is not accessible.
Make sure this is a valid URL and you have access to this file.`);
        if (abort) {
          abort.abort();
        }
        return false;
      }

      const contentLength = sourceLoader.length;

      if (config.sourceName.endsWith(".wacz") || config.sourceName.endsWith(".zip")) {
        loader = new WACZLoader(sourceLoader, config, name);

        if (config.onDemand) {
          //db = new WACZRemoteArchiveDB(config.dbname, sourceLoader, config);
          db = new SingleWACZ(config, sourceLoader);
          type = "remotezip";
        } else {
          progressUpdate(0, "Sorry, can't load this WACZ file due to lack of range request support on the server");
          if (abort) {
            abort.abort();
          }
          return false;
        }

      } else if (config.sourceName.endsWith(".warc") || config.sourceName.endsWith(".warc.gz")) {
        if (contentLength < MAX_FULL_DOWNLOAD_SIZE || !sourceLoader.canLoadOnDemand) {
          loader = new WARCLoader(stream, abort, name);
        } else {
          loader = new CDXFromWARCLoader(stream, abort, name);
          type = "remotesource";
          db = new RemoteSourceArchiveDB(config.dbname, sourceLoader, config.noCache);
        }

      } else if (config.sourceName.endsWith(".cdxj") || config.sourceName.endsWith(".cdx")) {
        config.remotePrefix = data.remotePrefix || loadUrl.slice(0, loadUrl.lastIndexOf("/") + 1);
        loader = new CDXLoader(stream, abort, name);
        type = "remoteprefix";
        db = new RemotePrefixArchiveDB(config.dbname, config.remotePrefix, config.headers, config.noCache);
      
      // } else if (config.sourceName.endsWith(".wbn")) {
      //   //todo: fix
      //   loader = new WBNLoader(await response.arrayBuffer());
      //   config.decode = false;

      // } else if (config.sourceName.endsWith(".har")) {
      //   //todo: fix
      //   loader = new HARLoader(await response.json());
      //   config.decode = false;
      } else if (config.sourceName.endsWith(".json")) {
        db = new MultiWACZCollection(config);
        loader = new JSONMultiWACZLoader(await response.json(), config.loadUrl);
      }

      if (!loader) {
        progressUpdate(0, `The ${config.sourceName} is not a known archive format that could be loaded.`);
        if (abort) {
          abort.abort();
        }
        return false;
      }

      if (!db) {
        db = new ArchiveDB(config.dbname);
      }
      await db.initing;

      try {
        config.metadata = await loader.load(db, progressUpdate, contentLength);
      } catch (e) {
        if (!(e instanceof Canceled)) {
          progressUpdate(0, `Unexpected Loading Error: ${e.toString()}`);
          console.warn(e);
        }
        return false;
      }

      if (!config.metadata.size) {
        config.metadata.size = contentLength;
      }
    }

    config.ctime = new Date().getTime();

    if (config.extra && config.extra.fileHandle) {
      delete this._fileHandles[config.sourceUrl];
    }

    const collData = {name, type, config};
    await this.colldb.add("colls", collData);
    collData.store = db;
    return collData;
  }
}


export { CollectionLoader, WorkerLoader };
