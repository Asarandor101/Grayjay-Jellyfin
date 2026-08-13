/*
 * Jellyfin -> Grayjay experimental source, v11
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
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,ChildCount" +
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
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,ChildCount" +
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
 * v10 SERIES NAVIGATION
 *
 * Series and seasons are represented as Grayjay channels instead of playlists.
 * v9 showed that custom playlist URLs are resolved through Grayjay's playlist
 * client path and therefore did not route back into this source.
 *
 * Channel URLs are explicitly supported by the Grayjay source API:
 *   jellyfin://series/<seriesId>
 *   jellyfin://season/<seasonId>
 */

source.isChannelUrl = function(url) {
    return /^jellyfin:\/\/(series|season)\/[A-Za-z0-9-]+$/.test(url || "");
};

source.getChannel = function(url) {
    ensureUser();

    const parsed = parseContainerUrl(url);
    const item = apiJson(
        "/Users/" + enc(USER.Id) + "/Items/" + enc(parsed.id) +
        "?Fields=Overview,DateCreated,PremiereDate,ImageTags,BackdropImageTags,IndexNumber,ChildCount"
    );

    return containerChannel(item, parsed.kind);
};

source.getChannelCapabilities = function() {
    return {
        types: [Type.Feed.Mixed],
        sorts: [],
        filters: []
    };
};

source.getChannelContents = function(url, type, order, filters, continuationToken) {
    ensureUser();

    const parsed = parseContainerUrl(url);
    const start = parseInt(continuationToken || "0");
    const limit = 100;

    if (parsed.kind === "series") {
        // Only seasons are exposed here.
        const data = apiJson(
            "/Users/" + enc(USER.Id) + "/Items" +
            "?ParentId=" + enc(parsed.id) +
            "&Recursive=false" +
            "&IncludeItemTypes=Season" +
            "&Fields=Overview,DateCreated,PremiereDate,ImageTags,BackdropImageTags,IndexNumber,ChildCount" +
            "&EnableImages=true" +
            "&ImageTypeLimit=1" +
            "&SortBy=IndexNumber" +
            "&SortOrder=Ascending" +
            "&StartIndex=" + start +
            "&Limit=" + limit
        );

        const seasons = (data.Items || []).map(function(item) {
            return seasonFeedItem(item);
        });

        const total = data.TotalRecordCount || (start + seasons.length);
        const hasMore = start + seasons.length < total;
        return new ContentPager(
            seasons,
            hasMore,
            hasMore ? String(start + limit) : null
        );
    }

    // A season exposes its episodes as normal playable Grayjay videos.
    const data = apiJson(
        "/Users/" + enc(USER.Id) + "/Items" +
        "?ParentId=" + enc(parsed.id) +
        "&Recursive=false" +
        "&IncludeItemTypes=Episode" +
        "&Fields=Overview,DateCreated,PremiereDate,RunTimeTicks,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags" +
        "&EnableImages=true" +
        "&ImageTypeLimit=1" +
        "&SortBy=IndexNumber" +
        "&SortOrder=Ascending" +
        "&StartIndex=" + start +
        "&Limit=" + limit
    );

    const episodes = (data.Items || []).map(toPlatformVideo);
    const total = data.TotalRecordCount || (start + episodes.length);
    const hasMore = start + episodes.length < total;

    return new ContentPager(
        episodes,
        hasMore,
        hasMore ? String(start + limit) : null
    );
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
        return seriesFeedItem(item);

    return toPlatformVideo(item);
}

function seriesFeedItem(item) {
    const id = String(item && item.Id ? item.Id : "");
    const title = item && item.Name ? item.Name : "Untitled Series";
    const seriesUrl = "jellyfin://series/" + id;

    /*
     * PlatformNestedMediaContent inherits PlatformContent, so Grayjay can
     * safely place it in Home/Search ContentPagers.
     *
     * contentUrl points at our own Jellyfin channel URL. When opened,
     * Grayjay resolves that URL back through this plugin's isChannelUrl().
     */
    return new PlatformNestedMediaContent({
        id: platformId(id),
        name: title,
        thumbnails: thumbnailsFor(item),
        author: new PlatformAuthorLink(
            platformId(id),
            "Jellyfin",
            seriesUrl,
            primaryImageUrl(item, 256)
        ),
        uploadDate: dateSeconds(item.PremiereDate || item.DateCreated),
        url: seriesUrl,
        contentUrl: seriesUrl,
        contentName: title,
        contentDescription: item && item.Overview ? item.Overview : "",
        contentProvider: "Jellyfin",
        contentThumbnails: thumbnailsFor(item)
    });
}


function seasonFeedItem(item) {
    const id = String(item && item.Id ? item.Id : "");
    const title = item && item.Name ? item.Name : "Season";
    const seasonUrl = "jellyfin://season/" + id;

    return new PlatformNestedMediaContent({
        id: platformId(id),
        name: title,
        thumbnails: thumbnailsFor(item),
        author: new PlatformAuthorLink(
            platformId(id),
            "Jellyfin",
            seasonUrl,
            primaryImageUrl(item, 256)
        ),
        uploadDate: dateSeconds(item.PremiereDate || item.DateCreated),
        url: seasonUrl,
        contentUrl: seasonUrl,
        contentName: title,
        contentDescription: item && item.Overview ? item.Overview : "",
        contentProvider: "Jellyfin",
        contentThumbnails: thumbnailsFor(item)
    });
}

function containerChannel(item, kind) {
    const id = String(item && item.Id ? item.Id : "");
    const name = item && item.Name
        ? item.Name
        : (kind === "season" ? "Season" : "Series");

    return new PlatformChannel({
        id: platformId(id),
        name: name,
        thumbnail: primaryImageUrl(item, 640),
        banner: backdropImageUrl(item, 1280),
        subscribers: 0,
        description: item && item.Overview ? item.Overview : "",
        url: "jellyfin://" + kind + "/" + id,
        urlAlternatives: [],
        links: {}
    });
}

function parseContainerUrl(url) {
    const m = /^jellyfin:\/\/(series|season)\/([A-Za-z0-9-]+)$/.exec(url || "");

    if (!m)
        throw new ScriptException("Invalid Jellyfin series/season URL.");

    return {
        kind: m[1],
        id: m[2]
    };
}

function primaryImageUrl(item, width) {
    if (!item || !item.Id)
        return "";

    const tag = item.ImageTags && item.ImageTags.Primary
        ? "&tag=" + enc(item.ImageTags.Primary)
        : "";

    return SERVER + "/Items/" + enc(item.Id) +
        "/Images/Primary?maxWidth=" + (width || 640) +
        "&quality=90" + tag;
}

function backdropImageUrl(item, width) {
    if (!item || !item.Id || !item.BackdropImageTags || item.BackdropImageTags.length === 0)
        return primaryImageUrl(item, width || 1280);

    return SERVER + "/Items/" + enc(item.Id) +
        "/Images/Backdrop/0?maxWidth=" + (width || 1280) +
        "&quality=90&tag=" + enc(item.BackdropImageTags[0]);
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
