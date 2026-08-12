/*
 * Jellyfin -> Grayjay experimental source, MVP v1
 * No external telemetry. Requests are made only to the configured Jellyfin server.
 *
 * IMPORTANT:
 * - This is a developer prototype and has not been runtime-tested on every Grayjay/Jellyfin build.
 * - Direct-play is preferred. Some codecs/containers can still require Jellyfin transcoding
 *   or may not play on the Android device.
 */

let cfg = {};
let localSettings = {};
let SERVER = "";
let TOKEN = "";
let USER = null;

source.enable = function(conf, settings, savedState) {
    cfg = conf || {};
    localSettings = settings || {};
    SERVER = normalizeServer(localSettings.serverUrl || "");
    TOKEN = (localSettings.accessToken || "").trim();

    if (!SERVER)
        throw new ScriptException("Jellyfin server URL is missing.");
    if (!TOKEN)
        throw new ScriptException("Jellyfin access token is missing.");

    USER = apiJson("/Users/Me");
};

source.disable = function() {
    USER = null;
};

source.getHome = function(continuationToken) {
    const start = parseInt(continuationToken || "0");
    const limit = 40;
    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?Recursive=true" +
        "&IncludeItemTypes=Movie,Episode" +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,ParentIndexNumber,IndexNumber" +
        "&SortBy=DateCreated" +
        "&SortOrder=Descending" +
        "&StartIndex=" + start +
        "&Limit=" + limit
    );
    return toPager(data, start, limit);
};

source.search = function(query, type, order, filters) {
    const q = (query || "").trim();
    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?Recursive=true" +
        "&IncludeItemTypes=Movie,Episode" +
        "&SearchTerm=" + enc(q) +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,ParentIndexNumber,IndexNumber" +
        "&Limit=80"
    );
    const items = (data.Items || []).map(toPlatformVideo);
    return new ContentPager(items, false);
};

source.isContentDetailsUrl = function(url) {
    return /^jellyfin:\/\/item\/[A-Za-z0-9-]+$/.test(url || "");
};

source.getContentDetails = function(url) {
    const id = itemIdFromUrl(url);
    const item = apiJson("/Users/" + enc(USER.Id) + "/Items/" + enc(id) +
        "?Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,ParentIndexNumber,IndexNumber,Path");

    const mediaSources = item.MediaSources || [];
    const videoSources = [];

    for (let i = 0; i < mediaSources.length; i++) {
        const ms = mediaSources[i];
        // Jellyfin's Videos/{id}/stream endpoint supports direct streaming and
        // lets the server decide whether direct play/remux/transcode is needed.
        // Static=true strongly prefers the original/direct path.
        const streamUrl = SERVER + "/Videos/" + enc(item.Id) + "/stream" +
            "?Static=true" +
            "&MediaSourceId=" + enc(ms.Id || "") +
            "&api_key=" + enc(TOKEN);

        let width = 0, height = 0, codec = "";
        const streams = ms.MediaStreams || [];
        for (let j = 0; j < streams.length; j++) {
            if (streams[j].Type === "Video") {
                width = streams[j].Width || 0;
                height = streams[j].Height || 0;
                codec = streams[j].Codec || "";
                break;
            }
        }

        videoSources.push(new VideoUrlSource({
            width: width,
            height: height,
            container: mimeForContainer(ms.Container),
            codec: codec,
            name: qualityName(width, height, ms.Container),
            bitrate: ms.Bitrate || 0,
            duration: ticksToSeconds(item.RunTimeTicks),
            url: streamUrl
        }));
    }

    // Fallback when MediaSources is omitted by a server/version.
    if (videoSources.length === 0) {
        videoSources.push(new VideoUrlSource({
            width: 0,
            height: 0,
            container: "video/*",
            codec: "",
            name: "Jellyfin direct stream",
            bitrate: 0,
            duration: ticksToSeconds(item.RunTimeTicks),
            url: SERVER + "/Videos/" + enc(item.Id) + "/stream?Static=true&api_key=" + enc(TOKEN)
        }));
    }

    return new PlatformVideoDetails({
        id: item.Id,
        name: displayTitle(item),
        thumbnails: new Thumbnails([
            new Thumbnail(imageUrl(item.Id, 1280, 720), 720),
            new Thumbnail(imageUrl(item.Id, 640, 360), 360)
        ]),
        author: new PlatformAuthorLink(
            item.SeriesName || "Jellyfin",
            SERVER,
            SERVER,
            ""
        ),
        uploadDate: dateSeconds(item.PremiereDate || item.DateCreated),
        duration: ticksToSeconds(item.RunTimeTicks),
        viewCount: 0,
        url: "jellyfin://item/" + item.Id,
        description: item.Overview || "",
        video: new VideoSourceDescriptor(videoSources),
        rating: null
    });
};

source.getSearchCapabilities = function() {
    return {
        types: [Type.Feed.Videos],
        sorts: [],
        filters: []
    };
};

source.getHomeCapabilities = function() {
    return {
        types: [Type.Feed.Videos],
        sorts: [],
        filters: []
    };
};

function apiJson(path) {
    const headers = {
        "Accept": "application/json",
        "X-Emby-Token": TOKEN,
        "Authorization": 'MediaBrowser Client="Grayjay Jellyfin", Device="Android", DeviceId="grayjay-jellyfin", Version="0.1", Token="' + TOKEN + '"'
    };
    const res = http.GET(SERVER + path, headers);
    if (!res || !res.isOk)
        throw new ScriptException("Jellyfin request failed: " + path + " (HTTP " + (res ? res.code : "?") + ")");
    return JSON.parse(res.body);
}

function toPager(data, start, limit) {
    const items = (data.Items || []).map(toPlatformVideo);
    const total = data.TotalRecordCount || (start + items.length);
    const hasMore = start + items.length < total;
    return new ContentPager(items, hasMore, hasMore ? String(start + limit) : null);
}

function toPlatformVideo(item) {
    return new PlatformVideo({
        id: item.Id,
        name: displayTitle(item),
        thumbnails: new Thumbnails([
            new Thumbnail(imageUrl(item.Id, 640, 360), 360)
        ]),
        author: new PlatformAuthorLink(
            item.SeriesName || "Jellyfin",
            SERVER,
            SERVER,
            ""
        ),
        uploadDate: dateSeconds(item.PremiereDate || item.DateCreated),
        duration: ticksToSeconds(item.RunTimeTicks),
        viewCount: 0,
        url: "jellyfin://item/" + item.Id,
        isLive: false
    });
}

function imageUrl(id, width, height) {
    // Token is included because Grayjay's image loader may not attach plugin HTTP headers.
    // Keep the server local/trusted and avoid logging full URLs.
    return SERVER + "/Items/" + enc(id) + "/Images/Primary?fillWidth=" + width +
        "&fillHeight=" + height + "&quality=90&api_key=" + enc(TOKEN);
}

function displayTitle(item) {
    if (item.Type === "Episode" && item.SeriesName) {
        const s = item.ParentIndexNumber != null ? "S" + pad2(item.ParentIndexNumber) : "";
        const e = item.IndexNumber != null ? "E" + pad2(item.IndexNumber) : "";
        return item.SeriesName + " — " + s + e + " " + (item.Name || "");
    }
    return item.Name || "Untitled";
}

function normalizeServer(s) {
    s = (s || "").trim();
    while (s.endsWith("/")) s = s.slice(0, -1);
    return s;
}

function itemIdFromUrl(url) {
    const m = /^jellyfin:\/\/item\/([A-Za-z0-9-]+)$/.exec(url || "");
    if (!m) throw new ScriptException("Invalid Jellyfin item URL.");
    return m[1];
}

function enc(v) { return encodeURIComponent(v == null ? "" : String(v)); }
function ticksToSeconds(t) { return t ? Math.floor(t / 10000000) : 0; }
function dateSeconds(v) {
    if (!v) return Math.floor(Date.now() / 1000);
    const d = Date.parse(v);
    return isNaN(d) ? Math.floor(Date.now() / 1000) : Math.floor(d / 1000);
}
function pad2(v) { v = String(v); return v.length < 2 ? "0" + v : v; }
function mimeForContainer(c) {
    c = (c || "").toLowerCase();
    if (c.indexOf("mp4") >= 0 || c.indexOf("m4v") >= 0) return "video/mp4";
    if (c.indexOf("webm") >= 0) return "video/webm";
    if (c.indexOf("matroska") >= 0 || c.indexOf("mkv") >= 0) return "video/x-matroska";
    return "video/*";
}
function qualityName(w, h, c) {
    let q = h ? (h + "p") : (w ? (w + "px") : "Original");
    return q + (c ? " " + String(c).toUpperCase() : "");
}
