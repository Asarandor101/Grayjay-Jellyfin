/*
 * Jellyfin -> Grayjay experimental source, v12
 *
 * Changes from v6:
 * - Adds Jellyfin Primary images as Grayjay thumbnails.
 * - Keeps the working v5/v6 Grayjay authentication flow.
 *
 * Note:
 * Thumbnail URLs intentionally do NOT contain a Jellyfin access token.
 * This avoids leaking a token into URLs/logs. We first test whether
 * Grayjay's image loading path applies the stored source authentication.
 */

const SERVER = "http://192.168.0.140:40215";
const PLUGIN_ID = "b90eb605-50b0-4a8b-9fb8-8a755da10216";
let USER = null;
let CONFIG = null;

source.enable = function(conf, settings, savedState) {
    CONFIG = conf || {};
    USER = apiJson("/Users/Me");
};

source.disable = function() {
    USER = null;
    CONFIG = null;
};

source.getHome = function(continuationToken) {
    ensureUser();

    const start = parseInt(continuationToken || "0");
    const limit = 40;

    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?Recursive=true" +
        "&IncludeItemTypes=Movie,Series" +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,ChildCount" +
        "&EnableImages=true" +
        "&ImageTypeLimit=1" +
        "&SortBy=DateCreated" +
        "&SortOrder=Descending" +
        "&StartIndex=" + start +
        "&Limit=" + limit
    );

    return toMixedPager(data, start, limit);
};

source.search = function(query, type, order, filters) {
    ensureUser();

    const q = (query || "").trim();

    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?Recursive=true" +
        "&IncludeItemTypes=Movie,Series" +
        "&SearchTerm=" + enc(q) +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,ChildCount" +
        "&EnableImages=true" +
        "&ImageTypeLimit=1" +
        "&Limit=80"
    );

    return new ContentPager((data.Items || []).map(toMixedContent), false);
};

source.isContentDetailsUrl = function(url) {
    return /^jellyfin:\/\/item\/[A-Za-z0-9-]+$/.test(url || "");
};

source.getContentDetails = function(url) {
    ensureUser();

    const id = itemIdFromUrl(url);
    const item = apiJson(
        "/Users/" + enc(USER.Id) + "/Items/" + enc(id) +
        "?Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,Path,ImageTags"
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
        id: platformId(item.Id),
        name: displayTitle(item),
        thumbnails: thumbnailsFor(item),
        author: authorLink(item),
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
        types: [Type.Feed.Mixed],
        sorts: [],
        filters: []
    };
};

source.getHomeCapabilities = function() {
    return {
        types: [Type.Feed.Mixed],
        sorts: [],
        filters: []
    };
};


/*
 * v12 SERIES HANDLING
 *
 * Grayjay has a native remote-playlist flow. A Jellyfin series is exposed as
 * one PlatformPlaylist item in Home/Search. Opening it is handled by
 * source.isPlaylistUrl/source.getPlaylist, so Grayjay does not send the
 * jellyfin:// URL to its browser.
 *
 * The first stable version returns all episodes ordered Season -> Episode.
 * This is intentionally conservative. A true separate Seasons screen needs
 * either nested playlist UI support or a small Grayjay UI extension, which we
 * can add after this native playlist path is proven on your build.
 */

source.isPlaylistUrl = function(url) {
    return /^jellyfin:\/\/series\/[A-Za-z0-9-]+$/.test(url || "");
};

source.getPlaylist = function(url) {
    ensureUser();

    const seriesId = seriesIdFromUrl(url);

    const series = apiJson(
        "/Users/" + enc(USER.Id) + "/Items/" + enc(seriesId) +
        "?Fields=Overview,DateCreated,PremiereDate,ImageTags,ChildCount"
    );

    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?Recursive=true" +
        "&ParentId=" + enc(seriesId) +
        "&IncludeItemTypes=Episode" +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags" +
        "&EnableImages=true" +
        "&ImageTypeLimit=1" +
        "&SortBy=ParentIndexNumber,IndexNumber" +
        "&SortOrder=Ascending" +
        "&Limit=10000"
    );

    const episodes = (data.Items || []).map(toPlatformVideo);

    return new PlatformPlaylistDetails({
        id: platformId(seriesId),
        name: series.Name || "Jellyfin Series",
        thumbnails: thumbnailsFor(series),
        author: new PlatformAuthorLink(
            platformId(seriesId),
            "Jellyfin",
            SERVER,
            primaryImageUrl(series, 256)
        ),
        uploadDate: dateSeconds(series.PremiereDate || series.DateCreated),
        url: "jellyfin://series/" + seriesId,
        videoCount: episodes.length,
        thumbnail: primaryImageUrl(series, 960),
        contents: new ContentPager(episodes, false)
    });
};

function toMixedPager(data, start, limit) {
    const items = (data.Items || []).map(toMixedContent);
    const total = data.TotalRecordCount || (start + items.length);
    const hasMore = start + items.length < total;

    return new ContentPager(
        items,
        hasMore,
        hasMore ? String(start + limit) : null
    );
}

function toMixedContent(item) {
    if (item && item.Type === "Series")
        return toSeriesPlaylist(item);

    return toPlatformVideo(item);
}

function toSeriesPlaylist(item) {
    const id = String(item && item.Id ? item.Id : "");

    return new PlatformPlaylist({
        id: platformId(id),
        name: item && item.Name ? item.Name : "Untitled Series",
        thumbnails: thumbnailsFor(item),
        author: new PlatformAuthorLink(
            platformId(id),
            "Jellyfin",
            SERVER,
            primaryImageUrl(item, 256)
        ),
        uploadDate: dateSeconds(item.PremiereDate || item.DateCreated),
        url: "jellyfin://series/" + id,
        videoCount: item && item.ChildCount ? item.ChildCount : 0,
        thumbnail: primaryImageUrl(item, 960)
    });
}

function seriesIdFromUrl(url) {
    const m = /^jellyfin:\/\/series\/([A-Za-z0-9-]+)$/.exec(url || "");

    if (!m)
        throw new ScriptException("Invalid Jellyfin series URL.");

    return m[1];
}

function primaryImageUrl(item, width) {
    if (!item || !item.Id)
        return "";

    const tag = item.ImageTags && item.ImageTags.Primary
        ? "&tag=" + enc(item.ImageTags.Primary)
        : "";

    return SERVER + "/Items/" + enc(item.Id) +
        "/Images/Primary?maxWidth=" + (width || 960) +
        "&quality=90" + tag;
}

function ensureUser() {
    if (!USER)
        USER = apiJson("/Users/Me");
}

function apiJson(path) {
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

function platformId(itemId) {
    return new PlatformID(
        "Jellyfin",
        String(itemId || ""),
        CONFIG && CONFIG.id ? CONFIG.id : PLUGIN_ID
    );
}

function authorLink(item) {
    const authorName = item.SeriesName || "Jellyfin";
    const authorId = item.SeriesId || item.ParentId || "jellyfin";

    return new PlatformAuthorLink(
        platformId(authorId),
        authorName,
        SERVER,
        ""
    );
}

function thumbnailsFor(item) {
    if (!item || !item.Id)
        return new Thumbnails([]);

    const tag = item.ImageTags && item.ImageTags.Primary
        ? "&tag=" + enc(item.ImageTags.Primary)
        : "";

    const base = SERVER + "/Items/" + enc(item.Id) + "/Images/Primary";

    return new Thumbnails([
        new Thumbnail(base + "?maxWidth=480&quality=85" + tag, 480),
        new Thumbnail(base + "?maxWidth=960&quality=90" + tag, 960)
    ]);
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
        id: platformId(item.Id),
        name: displayTitle(item),
        thumbnails: thumbnailsFor(item),
        author: authorLink(item),
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
