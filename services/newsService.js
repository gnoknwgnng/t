const Parser = require('rss-parser');

// ---------------------------------------------------------------------------
// Where the news comes from.
//
// Each built-in category has one or more publisher feeds. Google News search
// is used as a top-up when those feeds are thin or down, and as the only
// source for custom topics (any text the user types, e.g. "electric
// vehicles"). Every story carries its real publish date, and callers only
// ever get recent stories: there are no canned "fallback" articles, so a post
// can never be written about news that did not happen.
// ---------------------------------------------------------------------------
const CATEGORY_FEEDS = {
    tech: ['https://techcrunch.com/feed/'],
    science: ['https://www.sciencedaily.com/rss/all.xml'],
    dental: [
        'https://www.dentistrytoday.com/feed/',
        'https://www.sciencedaily.com/rss/health_medicine/dentistry.xml'
    ]
};

// Search phrase used for the Google News top-up of each built-in category.
const CATEGORY_SEARCH = {
    tech: 'technology',
    science: 'science research',
    dental: 'dentistry OR dental'
};

const CACHE_TTL_MS = 30 * 60 * 1000;      // refetch a feed at most every 30 minutes
const FRESH_HOURS = 48;                   // what counts as "today's news"
const RECENT_HOURS = 7 * 24;              // widest window we will ever post from
const MIN_FRESH_BEFORE_TOP_UP = 5;        // below this, also ask Google News
const MAX_TOPIC_LENGTH = 40;

function stripHtml(htmlString) {
    if (!htmlString) return '';
    return String(htmlString)
        .replace(/<[^>]*>?/gm, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Lower-cases and cleans a category or custom topic so the same text always
// maps to the same cache entry and is safe to put in a search URL.
function normalizeCategory(category) {
    return String(category || '')
        .toLowerCase()
        .replace(/[^a-z0-9 &+.\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TOPIC_LENGTH);
}

function isBuiltInCategory(category) {
    return Object.prototype.hasOwnProperty.call(CATEGORY_FEEDS, category);
}

function googleNewsUrl(query) {
    // "when:7d" keeps Google's results to the last week.
    const q = encodeURIComponent(`${query} when:7d`);
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function parseDate(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
}

function ageInHours(article, now = Date.now()) {
    const time = parseDate(article.publishedAt);
    return time === null ? Infinity : (now - time) / 3600000;
}

function articleKey(article) {
    return String(article.link || article.title || '').trim().toLowerCase();
}

function titleKey(article) {
    return String(article.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Pure helper (also used by the tests): from a pool of articles, return the
// ones worth posting about, newest first.
//   - never anything already used (by link or by headline)
//   - prefer the last 48 hours; widen to 7 days only when that leaves too few
//   - undated stories are only used when nothing dated is available
function selectFreshArticles(articles, options = {}) {
    const now = options.now || Date.now();
    const limit = options.limit || 10;
    const excluded = new Set([...(options.excludeUrls || [])].map((value) => String(value).trim().toLowerCase()));
    const excludedTitles = new Set([...(options.excludeTitles || [])].map((value) => titleKey({ title: value })));

    const seen = new Set();
    const candidates = (articles || []).filter((article) => {
        const key = articleKey(article);
        const tKey = titleKey(article);
        if (!key || excluded.has(key) || excludedTitles.has(tKey)) return false;
        if (seen.has(key) || seen.has(tKey)) return false;
        seen.add(key);
        seen.add(tKey);
        return true;
    });

    const byNewest = (a, b) => ageInHours(a, now) - ageInHours(b, now);
    const fresh = candidates.filter((article) => ageInHours(article, now) <= FRESH_HOURS).sort(byNewest);
    if (fresh.length >= limit) {
        return fresh.slice(0, limit);
    }

    const recent = candidates.filter((article) => ageInHours(article, now) <= RECENT_HOURS).sort(byNewest);
    if (recent.length) {
        return recent.slice(0, limit);
    }

    // Nothing dated within a week: fall back to undated items only (feeds
    // that publish no dates), never to stories known to be old.
    return candidates.filter((article) => parseDate(article.publishedAt) === null).slice(0, limit);
}

class NewsService {
    constructor() {
        this.parser = new Parser({
            headers: {
                'User-Agent': 'PostCraftAI/1.0 (Mozilla/5.0; Windows NT 10.0; Win64; x64)',
                'Accept': 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8'
            },
            timeout: 12000
        });

        this.cache = new Map(); // category => { items, lastUpdated }
    }

    stripHtml(htmlString) {
        return stripHtml(htmlString);
    }

    async fetchFeed(feedUrl, category, { fromGoogle = false } = {}) {
        const feed = await this.parser.parseURL(feedUrl);
        const feedTitle = feed.title ? stripHtml(feed.title) : '';

        return (feed.items || []).map((item) => {
            let title = stripHtml(item.title);
            let source = feedTitle || category;

            // Google News titles look like "Headline - Publisher".
            if (fromGoogle) {
                const split = title.lastIndexOf(' - ');
                if (split > 20) {
                    source = title.slice(split + 3).trim();
                    title = title.slice(0, split).trim();
                }
            }

            let summary = stripHtml(item.contentSnippet || item.summary || item.content || item.description || '');
            if (fromGoogle || !summary) {
                // Google's snippet is just the headline again.
                summary = title;
            }
            if (summary.length > 350) {
                summary = summary.substring(0, 350) + '...';
            }

            let rawLink = item.link || item.guid || (typeof item.id === 'string' ? item.id : '');
            if (rawLink && typeof rawLink === 'object' && rawLink.href) {
                rawLink = rawLink.href;
            }

            const publishedTime = parseDate(item.isoDate || item.pubDate);

            return {
                category,
                title,
                summary,
                link: String(rawLink || '').trim(),
                // null (not "now") when the feed gives no date, so an old
                // undated story can never pass as fresh.
                publishedAt: publishedTime === null ? null : new Date(publishedTime).toISOString(),
                source
            };
        }).filter((item) => {
            if (!item.title || !item.link.startsWith('http')) return false;
            try {
                // Reject links that are just a site's home page or feed.
                const url = new URL(item.link);
                const path = url.pathname.replace(/\/+$/, '');
                return path !== '' && !/\/(feed|rss)$/i.test(path);
            } catch (error) {
                return false;
            }
        });
    }

    async loadCategory(category) {
        const feeds = CATEGORY_FEEDS[category] || [];
        const now = Date.now();
        let items = [];

        const results = await Promise.allSettled(feeds.map((url) => this.fetchFeed(url, category)));
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                items = items.concat(result.value);
            } else {
                console.error(`[NewsService] Feed failed for '${category}' (${feeds[index]}): ${result.reason?.message}`);
            }
        });

        const freshCount = items.filter((article) => ageInHours(article, now) <= FRESH_HOURS).length;
        if (freshCount < MIN_FRESH_BEFORE_TOP_UP) {
            const query = CATEGORY_SEARCH[category] || category;
            try {
                const extra = await this.fetchFeed(googleNewsUrl(query), category, { fromGoogle: true });
                items = items.concat(extra);
            } catch (error) {
                console.error(`[NewsService] Google News top-up failed for '${category}': ${error.message}`);
            }
        }

        items.sort((a, b) => ageInHours(a, now) - ageInHours(b, now));
        return items;
    }

    // Every story currently known for a category, newest first.
    async getArticlesForCategory(category) {
        const key = normalizeCategory(category) || 'tech';
        const cached = this.cache.get(key);
        if (cached && cached.items.length && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
            return cached.items;
        }

        const items = await this.loadCategory(key);
        if (items.length) {
            this.cache.set(key, { items, lastUpdated: Date.now() });
            return items;
        }

        // Every source failed: reuse the last good fetch if there is one.
        return cached ? cached.items : [];
    }

    // Recent, not-yet-used stories for a category, newest first.
    async getFreshArticles(category, options = {}) {
        const articles = await this.getArticlesForCategory(category);
        return selectFreshArticles(articles, options);
    }

    // One story for a category that has not been used yet. `usedUrls` is
    // updated so repeated calls walk through different stories. Returns null
    // when no recent news could be loaded at all.
    async getArticleForCategory(category, usedUrls = new Set()) {
        let [article] = await this.getFreshArticles(category, { excludeUrls: usedUrls, limit: 1 });

        if (!article) {
            // Everything recent is used up: allow a repeat rather than
            // reaching for older news.
            [article] = await this.getFreshArticles(category, { limit: 1 });
        }

        if (!article) {
            return null;
        }

        usedUrls.add(articleKey(article));
        return article;
    }

    async refreshAllFeeds() {
        this.cache.clear();
        for (const category of Object.keys(CATEGORY_FEEDS)) {
            await this.getArticlesForCategory(category);
        }
    }
}

const service = new NewsService();
service.selectFreshArticles = selectFreshArticles;
service.normalizeCategory = normalizeCategory;
service.isBuiltInCategory = isBuiltInCategory;
service.ageInHours = ageInHours;

module.exports = service;
