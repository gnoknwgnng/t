// ---------------------------------------------------------------------------
// Every knob for how posts are chosen, written, checked and scheduled.
//
// Each value can be overridden with the environment variable named beside it
// (in Vercel: Project -> Settings -> Environment Variables). Values are read
// each time get() is called, so a change takes effect on the next request.
//
// These are only starting points. Where the Research Playbook
// (services/playbookService.js) has a rule for the same thing - length,
// hashtags, link placement, posting windows - the playbook wins.
// ---------------------------------------------------------------------------

function text(name, fallback) {
    const value = String(process.env[name] || '').trim();
    return value || fallback;
}

function number(name, fallback, min, max) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || String(process.env[name] || '').trim() === '') {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

function list(name, fallback) {
    const value = String(process.env[name] || '').trim();
    if (!value) return fallback;
    return value.split(/[\n|]+/).map((item) => item.trim()).filter(Boolean);
}

function flag(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

const DEFAULT_NICHE = 'AI and startup news that matters to Indian builders, founders and freshers';

// Checked on 2026-11-28: each of these returned stories from the last 48h.
const DEFAULT_NICHE_FEEDS = [
    'https://inc42.com/feed/',
    'https://yourstory.com/feed',
    'https://entrackr.com/rss',
    'https://analyticsindiamag.com/feed/',
    'https://www.medianama.com/feed/',
    'https://www.livemint.com/rss/AI',
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570550.cms'
];

// Google News searches used to top up the feeds above.
const DEFAULT_NICHE_SEARCHES = ['AI startup India', 'Indian startup funding'];

function get() {
    return {
        // ---- Niche (Step 2) ------------------------------------------------
        niche: text('POSTCRAFT_NICHE', DEFAULT_NICHE),
        nicheFeeds: list('POSTCRAFT_NICHE_FEEDS', DEFAULT_NICHE_FEEDS),            // separate with |
        nicheSearches: list('POSTCRAFT_NICHE_SEARCHES', DEFAULT_NICHE_SEARCHES),   // separate with |
        freshHours: number('POSTCRAFT_FRESH_HOURS', 48, 6, 168),
        // A story needs at least this (0-10) on BOTH niche relevance and
        // "so what" potential, or it is dropped.
        minStoryScore: number('POSTCRAFT_MIN_STORY_SCORE', 7, 0, 10),
        maxStoriesToScore: number('POSTCRAFT_MAX_STORIES_TO_SCORE', 14, 3, 30),

        // ---- Quality gate (Step 4) -----------------------------------------
        qualityMinScore: number('POSTCRAFT_QUALITY_MIN', 7, 1, 10),
        qualityMaxRetries: number('POSTCRAFT_QUALITY_RETRIES', 2, 0, 4),

        // ---- Links (Step 6) ------------------------------------------------
        // rotate | none | first_comment | in_body
        linkMode: text('POSTCRAFT_LINK_MODE', 'rotate').toLowerCase(),

        // ---- Cadence (Step 7) ----------------------------------------------
        postsPerWeek: number('POSTCRAFT_POSTS_PER_WEEK', 3, 1, 7),
        // 0 = Sunday ... 6 = Saturday. Order matters: the first N are used.
        postingDays: list('POSTCRAFT_POSTING_DAYS', ['2', '3', '4', '1']).map(Number).filter((day) => day >= 0 && day <= 6),
        windowStartHour: number('POSTCRAFT_WINDOW_START', 8, 0, 23),
        windowEndHour: number('POSTCRAFT_WINDOW_END', 10, 1, 24),
        timeZone: text('POSTCRAFT_TIMEZONE', 'Asia/Kolkata'),

        // ---- Research Playbook (Step 1b) -----------------------------------
        searchProvider: text('SEARCH_PROVIDER', 'tavily').toLowerCase(),   // tavily | brave | serper
        searchApiKey: text('SEARCH_API_KEY', ''),
        researchMaxSearches: number('POSTCRAFT_RESEARCH_MAX_SEARCHES', 8, 1, 20),
        researchMaxPages: number('POSTCRAFT_RESEARCH_MAX_PAGES', 10, 1, 25),
        researchIntervalDays: number('POSTCRAFT_RESEARCH_INTERVAL_DAYS', 7, 1, 60),
        // How many of my own posts a group needs before my numbers are
        // allowed to overrule the playbook.
        minPostsToLearn: number('POSTCRAFT_MIN_POSTS_TO_LEARN', 4, 2, 50),

        // ---- Model ---------------------------------------------------------
        // The primary model "thinks" before answering and that thinking is
        // counted against this limit, so it has to be generous.
        llmMaxTokens: number('POSTCRAFT_LLM_MAX_TOKENS', 3500, 800, 8000),
        // Quick model for scoring stories and judging drafts. If it is
        // unavailable the normal model list is used instead.
        fastModel: text('POSTCRAFT_FAST_MODEL', 'openai/gpt-oss-20b'),
        // Writing models in order of preference (checked on 2026-11-28).
        models: list('POSTCRAFT_MODELS', ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']),
        // A story needs at least this many characters of article text before
        // a post is written from it. With only a headline to go on, the
        // writer fills the gap with invented details.
        minStoryDetail: number('POSTCRAFT_MIN_STORY_DETAIL', 400, 0, 5000),

        // ---- Safety --------------------------------------------------------
        // When on, nothing is ever sent to LinkedIn: approving a draft only
        // records what would have been published.
        dryRun: flag('POSTCRAFT_DRY_RUN')
    };
}

module.exports = { get, DEFAULT_NICHE, DEFAULT_NICHE_FEEDS };
