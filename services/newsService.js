const Parser = require('rss-parser');

const RSS_FEEDS = {
    tech: 'https://techcrunch.com/feed/',
    science: 'https://www.sciencedaily.com/rss/all.xml',
    dental: 'https://www.dentistrytoday.com/feed/'
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Default fallbacks in case network is down and cache is empty
const FALLBACK_ARTICLES = {
    tech: [
        {
            category: 'tech',
            title: 'Emerging Breakthroughs in Artificial Intelligence and Cloud Compute',
            summary: 'Recent developments in scalable AI models and edge computing architecture are redefining how modern enterprise platforms deploy automated workflows.',
            link: 'https://techcrunch.com/category/artificial-intelligence/',
            publishedAt: new Date().toISOString(),
            source: 'TechCrunch'
        },
        {
            category: 'tech',
            title: 'Cybersecurity Best Practices for Cloud Infrastructure',
            summary: 'Industry leaders share essential guidelines for securing zero-trust architectures and data pipelines across multi-cloud environments.',
            link: 'https://techcrunch.com/category/enterprise/',
            publishedAt: new Date().toISOString(),
            source: 'TechCrunch'
        }
    ],
    science: [
        {
            category: 'science',
            title: 'New Study Highlights Innovations in Clean Energy and Storage',
            summary: 'Researchers have unveiled a promising material composition that enhances energy density and grid efficiency for renewable power applications.',
            link: 'https://www.sciencedaily.com/news/matter_energy/',
            publishedAt: new Date().toISOString(),
            source: 'ScienceDaily'
        },
        {
            category: 'science',
            title: 'Advances in Molecular Biology Open New Healthcare Horizons',
            summary: 'Cutting-edge discoveries in genome sequencing and biomarker diagnostics offer potential solutions for early disease detection.',
            link: 'https://www.sciencedaily.com/news/health_medicine/',
            publishedAt: new Date().toISOString(),
            source: 'ScienceDaily'
        }
    ],
    dental: [
        {
            category: 'dental',
            title: 'Modern Digital Dentistry: Transforming Patient Care with 3D Imaging',
            summary: 'Intraoral scanners and 3D printing technologies are revolutionizing restorative procedures, shortening appointment times, and raising standard of care.',
            link: 'https://www.dentistrytoday.com/category/clinical/',
            publishedAt: new Date().toISOString(),
            source: 'Dentistry Today'
        },
        {
            category: 'dental',
            title: 'Preventive Dental Care Strategies and Patient Wellness Innovations',
            summary: 'Clinical studies demonstrate the effective link between proactive oral hygiene routines and overall systemic health outcomes.',
            link: 'https://www.dentistrytoday.com/category/hygiene/',
            publishedAt: new Date().toISOString(),
            source: 'Dentistry Today'
        }
    ]
};

class NewsService {
    constructor() {
        this.parser = new Parser({
            headers: {
                'User-Agent': 'PostCraftAI/1.0 (Mozilla/5.0; Windows NT 10.0; Win64; x64)',
                'Accept': 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8'
            },
            timeout: 12000
        });

        this.cache = {
            tech: { items: [], lastUpdated: 0 },
            science: { items: [], lastUpdated: 0 },
            dental: { items: [], lastUpdated: 0 }
        };
    }

    stripHtml(htmlString) {
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

    async fetchCategoryFeed(category) {
        const feedUrl = RSS_FEEDS[category];
        if (!feedUrl) {
            console.error(`[NewsService] Unknown category: ${category}`);
            return this.cache[category]?.items || FALLBACK_ARTICLES[category] || [];
        }

        try {
            console.log(`📡 [NewsService] Fetching RSS feed for '${category}' from ${feedUrl}...`);
            const feed = await this.parser.parseURL(feedUrl);
            const sourceName = feed.title ? this.stripHtml(feed.title) : category.toUpperCase();

            const items = (feed.items || []).map((item) => {
                const title = this.stripHtml(item.title) || 'Untitled News';
                const rawSummary = item.contentSnippet || item.summary || item.content || item.description || '';
                let summary = this.stripHtml(rawSummary);
                if (summary.length > 350) {
                    summary = summary.substring(0, 350) + '...';
                }
                let rawLink = item.link || item.guid || (typeof item.id === 'string' ? item.id : '');
                if (typeof rawLink === 'object' && rawLink.href) {
                    rawLink = rawLink.href;
                }
                const link = String(rawLink || '').trim();
                const publishedAt = item.pubDate || item.isoDate || new Date().toISOString();

                return {
                    category,
                    title,
                    summary: summary || title,
                    link,
                    publishedAt,
                    source: sourceName
                };
            }).filter((item) => {
                if (!item.title || !item.link || !item.link.startsWith('http')) return false;
                const url = item.link.toLowerCase();
                // Reject generic homepage and feed URLs
                if (
                    url.endsWith('/feed') ||
                    url.endsWith('/feed/') ||
                    url.endsWith('/rss') ||
                    url.endsWith('/rss/') ||
                    url === 'https://techcrunch.com' ||
                    url === 'https://techcrunch.com/' ||
                    url === 'https://www.sciencedaily.com' ||
                    url === 'https://www.sciencedaily.com/' ||
                    url === 'https://www.dentistrytoday.com' ||
                    url === 'https://www.dentistrytoday.com/'
                ) {
                    return false;
                }
                return true;
            });

            items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

            if (items.length > 0) {
                this.cache[category] = {
                    items,
                    lastUpdated: Date.now()
                };
                console.log(`✅ [NewsService] Cached ${items.length} items for category '${category}'`);
            } else if (this.cache[category].items.length === 0) {
                this.cache[category].items = FALLBACK_ARTICLES[category] || [];
            }
        } catch (error) {
            console.error(`⚠️ [NewsService] Error fetching feed for '${category}': ${error.message}`);
            if (!this.cache[category] || !this.cache[category].items || this.cache[category].items.length === 0) {
                console.log(`ℹ️ [NewsService] Using fallback static articles for '${category}'`);
                this.cache[category] = {
                    items: FALLBACK_ARTICLES[category] || [],
                    lastUpdated: Date.now()
                };
            } else {
                console.log(`ℹ️ [NewsService] Retaining last cached ${this.cache[category].items.length} items for '${category}'`);
            }
        }

        return this.cache[category].items;
    }

    async refreshAllFeeds() {
        const categories = Object.keys(RSS_FEEDS);
        for (const cat of categories) {
            await this.fetchCategoryFeed(cat);
        }
    }

    async getArticlesForCategory(category) {
        const cat = String(category || 'tech').toLowerCase();
        const validCat = RSS_FEEDS[cat] ? cat : 'tech';
        const cacheEntry = this.cache[validCat];

        const isStale = !cacheEntry || (Date.now() - cacheEntry.lastUpdated > CACHE_TTL_MS);
        const isEmpty = !cacheEntry || !cacheEntry.items || cacheEntry.items.length === 0;

        if (isStale || isEmpty) {
            await this.fetchCategoryFeed(validCat);
        }

        return this.cache[validCat]?.items?.length > 0
            ? this.cache[validCat].items
            : (FALLBACK_ARTICLES[validCat] || []);
    }

    async getArticleForCategory(category, usedUrls = new Set()) {
        const articles = await this.getArticlesForCategory(category);
        if (!articles || articles.length === 0) {
            return (FALLBACK_ARTICLES[category] || FALLBACK_ARTICLES.tech)[0];
        }

        let unused = articles.find((art) => !usedUrls.has(art.link || art.title));

        if (!unused) {
            console.log(`🔄 [NewsService] RSS pool exhausted for '${category}', cycling back to first article.`);
            unused = articles[0];
        }

        usedUrls.add(unused.link || unused.title);
        return unused;
    }
}

module.exports = new NewsService();
