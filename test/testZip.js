import test from "ava";
import http from "http";

import { fetch } from "./helpers";

import listen from "test-listen";

import serveStatic from "serve-static";

import { ZipRangeReader } from "../src/wacz/ziprangereader";

import { createLoader } from "../src/blockloaders";

import { WARCParser } from "warcio";


const decoder = new TextDecoder("utf-8");


function createServer() {
  return http.createServer((req, res) => serveStatic("test/data")(req, res, () => {} ));
}


test.before(async t => {
  t.context.server = createServer();
  t.context.baseUrl = await listen(t.context.server);
});


test.after.always(t => {
  t.context.server.close();
});


test("test head", async t => {
  const res = await fetch(t.context.baseUrl + "/sample_dash.mpd",
    {method: "HEAD"});

  t.is(res.headers.get("Content-Length"), "3229");

});


test("test range", async t => {
  const res = await fetch(t.context.baseUrl + "/sample_dash.mpd",
    {headers: {"Range": "bytes=12-24"}});

  t.is(await res.text(), "urn:mpeg:dash");
});


test("load test.zip entries", async t => {
  const zipreader = new ZipRangeReader(createLoader({url: t.context.baseUrl + "/example.zip"}));

  const entries = await zipreader.load();

  t.deepEqual(entries, {
    "collection.yaml": { deflate: true, uncompressedSize: 389, compressedSize: 188, localEntryOffset: 0, filename: "collection.yaml" },
    "indexes/index.cdxj": { deflate: true, uncompressedSize: 1025, compressedSize: 443, localEntryOffset: 327, filename: "indexes/index.cdxj" },
    "warcs/httpbin-resource.warc.gz": { deflate: false, uncompressedSize: 465, compressedSize: 465, localEntryOffset: 910, filename: "warcs/httpbin-resource.warc.gz" },
    "warcs/example-iana.org-chunked.warc": { deflate: false, uncompressedSize: 8831, compressedSize: 8831, localEntryOffset: 1463, filename:  "warcs/example-iana.org-chunked.warc" },
    "warcs/example.warc.gz": { deflate: false, uncompressedSize: 3816, compressedSize: 3816, localEntryOffset: 10387, filename: "warcs/example.warc.gz" },
    "warcs/iana.warc.gz": { deflate: false, uncompressedSize: 786828, compressedSize: 786828, localEntryOffset: 14282, filename: "warcs/iana.warc.gz" }
  });
});


test("load test.zip file fully", async t => {
  const zipreader = new ZipRangeReader(createLoader({url: t.context.baseUrl + "/example.zip"}));

  const reader = await zipreader.loadFile("indexes/index.cdxj");

  const contents = decoder.decode(await reader.readFully());

  t.is(contents, `\
org,iana,www)/ 20170306165409 {"url":"http://www.iana.org/","mime":"text/html","status":200,"digest":"b1f949b4920c773fd9c863479ae9a788b948c7ad","length":7970,"offset":405,"filename":"example-iana.org-chunked.warc"}
com,example)/ 20170306040206 {"url":"http://example.com/","mime":"text/html","status":200,"digest":"G7HRM7BGOKSKMSXZAHMUQTTV53QOFSMK","length":1228,"offset":784,"filename":"example.warc.gz"}
com,example)/ 20170306040348 {"url":"http://example.com/","mime":"warc/revisit","status":200,"digest":"G7HRM7BGOKSKMSXZAHMUQTTV53QOFSMK","length":586,"offset":2621,"filename":"example.warc.gz"}
org,httpbin)/anything/resource.json 20171130220904 {"url":"http://httpbin.org/anything/resource.json","mime":"application/json","digest":"UQ3W6RIQVJO6ZEL55355BJODG2DMWBPH","length":465,"offset":0,"filename":"httpbin-resource.warc.gz"}
org,iana,www)/ 20140126200624 {"url":"http://www.iana.org/","mime":"text/html","status":200,"digest":"OSSAPWJ23L56IYVRW3GFEAR4MCJMGPTB","length":2258,"offset":334,"filename":"iana.warc.gz"}
`);

});


test("load test.zip WARC.GZ record", async t => {
  const zipreader = new ZipRangeReader(createLoader({url: t.context.baseUrl + "/example.zip"}));

  const reader = await zipreader.loadFileCheckDirs("example.warc.gz", 784, 1228);

  const parser = new WARCParser(reader);
  const record = await parser.parse();

  t.is(record.warcType, "response");
  t.is(record.warcTargetURI, "http://example.com/");
  t.is(record.warcPayloadDigest, "sha1:G7HRM7BGOKSKMSXZAHMUQTTV53QOFSMK");

  t.is(record.httpHeaders.headers.get("Content-Type"), "text/html");

  const line = await record.readline();
  t.is(line, "<!doctype html>\n");
});

test("load test.zip WARC record", async t => {
  const zipreader = new ZipRangeReader(createLoader({url: t.context.baseUrl + "/example.zip"}));

  const reader = await zipreader.loadFileCheckDirs("example-iana.org-chunked.warc", 405, 7970);

  const parser = new WARCParser(reader);
  const record = await parser.parse();

  t.is(record.warcType, "response");
  t.is(record.warcTargetURI, "http://www.iana.org/");
  t.is(record.warcPayloadDigest, "sha1:b1f949b4920c773fd9c863479ae9a788b948c7ad");

  t.is(record.httpHeaders.headers.get("Content-Type"), "text/html; charset=UTF-8");

  let text = "";
  let count = 0;
  for await (const line of record.iterLines()) {
    text += line.trimLeft();
    if (count++ === 3) break;
  }
  t.is(text, `\
<!doctype html>
<html>
<head>
<title>Internet Assigned Numbers Authority</title>
`);

});
