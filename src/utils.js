import { getReasonPhrase } from "http-status-codes";

// Threshold size for switching to range requests
export const MAX_FULL_DOWNLOAD_SIZE = 25000000;

export const PAGE_STATE_NOT_FINISHED = 0x00;
export const PAGE_STATE_NEED_REMOTE_SYNC = 0x10;
export const PAGE_STATE_NEED_LOCAL_SYNC = 0x01;
export const PAGE_STATE_SYNCED = 0x11;


export  function startsWithAny(value, iter) {
  for (const str of iter) {
    if (value.startsWith(str)) {
      return true;
    }
  }

  return false;
}

export function containsAny(value, iter) {
  for (const str of iter) {
    if (value.indexOf(str) >= 0) {
      return true;
    }
  }

  return false;
}

export function getTS(iso) {
  return iso.replace(/[-:T]/g, "").slice(0, 14);
}

export function getTSMillis(iso) {
  return iso.replace(/[-:.TZ]/g, "");
}

export function tsToDate(ts) {
  if (!ts) {
    return new Date();
  }

  if (ts.length < 17) {
    ts += "00000101000000000".substr(ts.length);
  }

  const datestr = (ts.substring(0, 4) + "-" +
    ts.substring(4, 6) + "-" +
    ts.substring(6, 8) + "T" +
    ts.substring(8, 10) + ":" +
    ts.substring(10, 12) + ":" +
    ts.substring(12, 14) + "." + 
    ts.substring(14) + "Z");

  return new Date(datestr);
}

export function tsToSec(ts) {
  return tsToDate(ts).getTime() / 1000;
}

export function getSecondsStr(date) {
  if (!date) {
    return "";
  }

  try {
    return "" + parseInt(date.getTime() / 1000);
  } catch (e) {
    return "";
  }
}

function base16(hashBuffer) {
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function digestMessage(message, hashtype) {
  const msgUint8 = typeof(message) === "string" ? new TextEncoder().encode(message) : message;
  const hashBuffer = await crypto.subtle.digest(hashtype, msgUint8);
  return hashtype + ":" + base16(hashBuffer);

}

export function decodeLatin1(buf) {
  let str = "";
  for (let i = 0; i < buf.length; i++) {
    str += String.fromCharCode(buf[i]);
  }
  return str;
}

export function encodeLatin1(str) {
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i) & 0xFF;
  }
  return buf;
}


//from http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
export function randomId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function makeHeaders(headers) {
  try {
    return new Headers(headers);
  } catch (e) {
    // try to sanitize the headers, if any errors
    for (let key of Object.keys(headers)) {
      const value = headers[key];
      const newValue = value.replace(/[\r\n]+/g, ", ");
      if (value != newValue) {
        headers[key] = newValue;
      }
    }
    return new Headers(headers);
  }
}

export function parseSetCookie(setCookie, scheme, cookieStr = "") {
  for (const cookie of setCookie.split(",")) {
    const cookieCore = cookie.split(";", 1)[0];
    // if has cookie flags
    if (cookieCore !== cookie) {
      const cookieRemainder = cookie.slice(cookieCore.length).toLowerCase();
      if (cookieRemainder.indexOf("httponly") > 0) {
        continue;
      }
      if (scheme === "http" && cookieRemainder.indexOf("secure") > 0) {
        continue;
      }
    }

    if (cookieStr) {
      cookieStr += "; ";
    }

    cookieStr += cookieCore;
  }

  return cookieStr;
}

const NULL_STATUS = [101, 204, 205, 304];

export function isNullBodyStatus(status) {
  return NULL_STATUS.includes(status);
}

export function getStatusText(status) {
  try {
    return getReasonPhrase(status);
  } catch (e) {
    return "Unknown Status";
  }
}

export function isAjaxRequest(request) {
  if (request.headers.get("X-Pywb-Requested-With") === "XMLHttpRequest") {
    return true;
  }

  if (request.mode === "cors") {
    return true;
  }

  return false;
}

export async function handleAuthNeeded(e) {
  if (e instanceof AuthNeededError) {
    //const client = await self.clients.get(event.clientId || event.resultingClientId);
    const clients = await self.clients.matchAll({ "type": "window" });
    for (const client of clients) {
      const url = new URL(client.url);
      if (url.searchParams.get("source") === this.config.sourceUrl) {
        client.postMessage({
          source: this.config.sourceUrl,
          coll: this.name,
          type: "authneeded",
          fileHandle: e.info && e.info.fileHandle,
        });
      }
    }
    return true;
  }

  return false;
}


export function notFound(request, msg, status = 404) {
  let content;
  let contentType;

  if (!msg) {
    msg = "Sorry, this url was not found in the archive.";
  }

  if (request.destination === "script" || request.headers.get("x-pywb-requested-with")) {
    content = JSON.stringify(msg);
    contentType = "application/json";
  } else {
    content = msg;
    contentType = "text/html";
  }

  //console.log(`Not Found ${request.destination} - ${msg}`);

  const initOpt = {
    "status": status,
    "statusText": getStatusText(status),
    "headers": { "Content-Type": contentType }
  };

  return new Response(content, initOpt);
}


// ===========================================================================
export class RangeError
{
  constructor(info = {}) {
    this.info = info;
  }

  toString() {
    return JSON.stringify(this.info);
  }
}

export class AuthNeededError extends RangeError
{
}

export class AccessDeniedError extends RangeError
{
}

export class Canceled
{
}

export function sleep(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

