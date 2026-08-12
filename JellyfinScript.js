/*
 * Jellyfin -> Grayjay experimental source, v5
 *
 * v5 fixes authentication:
 * - Grayjay captures Jellyfin's Authorization header during login.
 * - API calls use Grayjay's authenticated HTTP client.
 * - The script deliberately does NOT set its own Authorization header,
 *   so it cannot overwrite the stored Jellyfin login header.
 */

const SERVER = "http://192.168.0.140:40215";
let USER = null;

source.enable = function(conf, settings, savedState) {
    USER = apiJson("/Users/Me");
};

source.disable = function() {
    USER = null;
};

source.getHome = function(continuationToken) {
    ensureUser();

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
    ensureUser();

    const q = (query || "").trim();
    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?Recursive=true" +
        "&IncludeItemTypes=Movie,Episode" +
        "&SearchTerm=" + enc(q) +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,ParentIndexNumber,IndexNumber" +
        "&Limit=80"
    );

    return new ContentPager((data.Items || []).map(toPlatformVideo), false);
};

source.isContentDetailsUrl = function(url) {
    return /^jellyfin:\/\/item\/[A-Za-z0-9-]+$/.test(url || "");
};

source.getContentDetails = function(url) {
    ensureUser();

    const id = itemIdFromUrl(url);
    const item = apiJson(
        "/Users/" + enc(USER.Id) + "/Items/" + enc(id) +
        "?Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,ParentIndexNumber,IndexNumber,Path"
    );

    const mediaSources = item.MediaSources || [];
    const videoSources = [];

    for (let i = 0; i < mediaSources.length; i++) {
        const ms = mediaSources[i];

        let width = 0;
        let height = 0;
        let codec = "";

        const streams = ms.MediaStreams || [];
        for (let j = 0; j < streams.length; j++) {
            if (streams[j].Type === "Video") {
                width = streams[j].Width || 0;
                height = streams[j].Height || 0;
                codec = streams[j].Codec || "";
                break;
            }
        }

        /*
         * NOTE:
         * API authentication is fixed in v5.
         * Playback URLs still do not carry Grayjay's authenticated headers.
         * We will fix playback/download separately after Search/Home works.
         */
        videoSources.push(new VideoUrlSource({
            width: width,
            height: height,
            container: mimeForContainer(ms.Container),
            codec: codec,
            name: qualityName(width, height, ms.Container),
            bitrate: ms.Bitrate || 0,
            duration: ticksToSeconds(item.RunTimeTicks),
            url: SERVER + "/Videos/" + enc(item.Id) +
                 "/stream?Static=true&MediaSourceId=" + enc(ms.Id || "")
        }));
    }

    return new PlatformVideoDetails({
        id: item.Id,
        name: displayTitle(item),
        thumbnails: new Thumbnails([]),
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

function ensureUser() {
    if (!USER)
        USER = apiJson("/Users/Me");
}

function apiJson(path) {
    /*
     * IMPORTANT:
     * useAuthClient=true makes Grayjay add the Authorization header
     * captured during the Jellyfin login.
     *
     * Do not manually add Authorization here: doing so can overwrite
     * the authenticated header and cause HTTP 401.
     */
    const headers = {
        "Accept": "application/json"
    };

    const res = http.GET(SERVER + path, headers, true);

    if (!res || !res.isOk) {
        throw new ScriptException(
            "Jellyfin request failed: " + path +
            " (HTTP " + (res ? res.code : "?") + "). " +
            "If this is HTTP 401, open the source settings and sign in to Jellyfin again."
        );
    }

    return JSON.parse(res.body);
}

function toPager(data, start, limit) {
    const items = (data.Items || []).map(toPlatformVideo);
    const total = data.TotalRecordCount || (start + items.length);
    const hasMore = start + items.length < total;

    return new ContentPager(
        items,
        hasMore,
        hasMore ? String(start + limit) : null
    );
}

function toPlatformVideo(item) {
    return new PlatformVideo({
        id: item.Id,
        name: displayTitle(item),
        thumbnails: new Thumbnails([]),
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

function displayTitle(item) {
    if (item.Type === "Episode" && item.SeriesName) {
        const s = item.ParentIndexNumber != null
            ? "S" + pad2(item.ParentIndexNumber)
            : "";

        const e = item.IndexNumber != null
            ? "E" + pad2(item.IndexNumber)
            : "";

        return item.SeriesName + " — " + s + e + " " + (item.Name || "");
    }

    return item.Name || "Untitled";
}

function itemIdFromUrl(url) {
    const m = /^jellyfin:\/\/item\/([A-Za-z0-9-]+)$/.exec(url || "");

    if (!m)
        throw new ScriptException("Invalid Jellyfin item URL.");

    return m[1];
}

function enc(v) {
    return encodeURIComponent(v == null ? "" : String(v));
}

function ticksToSeconds(t) {
    return t ? Math.floor(t / 10000000) : 0;
}

function dateSeconds(v) {
    if (!v)
        return Math.floor(Date.now() / 1000);

    const d = Date.parse(v);

    return isNaN(d)
        ? Math.floor(Date.now() / 1000)
        : Math.floor(d / 1000);
}

function pad2(v) {
    v = String(v);
    return v.length < 2 ? "0" + v : v;
}

function mimeForContainer(c) {
    c = (c || "").toLowerCase();

    if (c.indexOf("mp4") >= 0 || c.indexOf("m4v") >= 0)
        return "video/mp4";

    if (c.indexOf("webm") >= 0)
        return "video/webm";

    if (c.indexOf("matroska") >= 0 || c.indexOf("mkv") >= 0)
        return "video/x-matroska";

    return "video/*";
}

function qualityName(w, h, c) {
    let q = h
        ? (h + "p")
        : (w ? (w + "px") : "Original");

    return q + (c ? " " + String(c).toUpperCase() : "");
}
