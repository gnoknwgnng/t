/**
 * News freshness, time-zone scheduling and endpoint protection tests.
 *
 * Runnable with: node tests/news-and-scheduling.test.js
 *
 * Nothing here talks to Supabase, LinkedIn, Telegram, Groq or any news feed:
 * the environment is blanked before the app is loaded, and records are kept
 * in a throw-away folder.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be set before any app module is required.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postcraft-test-'));
process.env.POSTCRAFT_DATA_DIR = dataDir;
process.env.VERCEL = '1';                    // no listen(), no scheduler, no Telegram polling
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.SUPABASE_SECRET_KEY = '';
process.env.SUPABASE_SERVICE_KEY = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.GROQ_API_KEY = 'test-key-not-used';
process.env.LINKEDIN_OAUTH_STATE_SECRET = 'test-secret';
process.env.CRON_SECRET = 'test-cron-secret';

const results = [];

async function runTest(label, fn) {
    try {
        await fn();
        results.push({ label, ok: true });
        console.log('  ✅ PASS  ' + label);
    } catch (error) {
        results.push({ label, ok: false });
        console.log('  ❌ FAIL  ' + label);
        console.log('           ' + error.message);
    }
}

const HOUR = 3600000;

(async function main() {
    const newsService = require('../services/newsService');
    const scheduler = require('../services/schedulerService');
    const LinkedInPostGenerator = require('../linkedinPostGenerator');

    // ------------------------------------------------------------------
    // News: only fresh, unused stories
    // ------------------------------------------------------------------
    const now = Date.parse('2026-11-24T06:00:00Z');
    const article = (title, hoursOld, extra = {}) => ({
        title,
        link: 'https://news.example/' + title.toLowerCase().replace(/\s+/g, '-'),
        summary: title,
        publishedAt: hoursOld === null ? null : new Date(now - hoursOld * HOUR).toISOString(),
        ...extra
    });

    await runTest('news: newest first, and stories older than 48h are left out when enough fresh ones exist', () => {
        const pool = [article('Old story', 100), article('Today B', 5), article('Today A', 1), article('Yesterday', 30)];
        const picked = newsService.selectFreshArticles(pool, { now, limit: 3 });
        assert.deepStrictEqual(picked.map((item) => item.title), ['Today A', 'Today B', 'Yesterday']);
    });

    await runTest('news: widens to the last 7 days only when fresh stories run short, never beyond', () => {
        const pool = [article('Today', 2), article('Four days old', 96), article('Three weeks old', 24 * 21)];
        const picked = newsService.selectFreshArticles(pool, { now, limit: 3 });
        assert.deepStrictEqual(picked.map((item) => item.title), ['Today', 'Four days old']);
    });

    await runTest('news: a story already used (by link or by headline) is never offered again', () => {
        const pool = [article('Used by link', 1), article('Used by title', 2), article('Brand new', 3)];
        const picked = newsService.selectFreshArticles(pool, {
            now,
            excludeUrls: new Set([pool[0].link]),
            excludeTitles: ['used by TITLE']
        });
        assert.deepStrictEqual(picked.map((item) => item.title), ['Brand new']);
    });

    await runTest('news: an undated story does not pass as fresh', () => {
        const pool = [article('No date', null), article('Dated', 10)];
        const picked = newsService.selectFreshArticles(pool, { now });
        assert.deepStrictEqual(picked.map((item) => item.title), ['Dated']);
    });

    await runTest('news: custom topics are cleaned into a safe search phrase', () => {
        assert.strictEqual(newsService.normalizeCategory('  Electric   Vehicles!! <script> '), 'electric vehicles script');
        assert.strictEqual(newsService.normalizeCategory('TECH'), 'tech');
        assert.ok(newsService.normalizeCategory('x'.repeat(200)).length <= 40);
    });

    // ------------------------------------------------------------------
    // Post text
    // ------------------------------------------------------------------
    await runTest('post text: links keep their underscores, markdown is removed', () => {
        const generator = new LinkedInPostGenerator();
        const cleaned = generator.cleanLinkedInText('Read https://site.com/a_b_c/d_e and _this_ plus **that**');
        assert.strictEqual(cleaned, 'Read https://site.com/a_b_c/d_e and this plus that');
    });

    await runTest('post text: the story link is always present, placed above the hashtags', () => {
        const generator = new LinkedInPostGenerator();
        const fixed = generator.ensureArticleLink('Body.\n\n#One #Two', { link: 'https://news.example/x' });
        assert.strictEqual(fixed, 'Body.\n\nRead more: https://news.example/x\n\n#One #Two');
    });

    // ------------------------------------------------------------------
    // Scheduling in the user's own time zone
    // ------------------------------------------------------------------
    await runTest('schedule: 10:00 in Asia/Kolkata is stored as 04:30 UTC', () => {
        const slots = scheduler.buildScheduleSlots(7, '2026-11-24', '2026-11-30', 10, { timeZone: 'Asia/Kolkata' });
        assert.strictEqual(slots.length, 7);
        assert.strictEqual(slots[0].toISOString(), '2026-11-24T04:30:00.000Z');
        assert.strictEqual(slots[6].toISOString(), '2026-11-30T04:30:00.000Z');
    });

    await runTest('schedule: the hour stays 10:00 on the clock across a daylight-saving change', () => {
        const beforeChange = scheduler.zonedTimeToUtc(2026, 3, 7, 10, 'America/New_York');
        const afterChange = scheduler.zonedTimeToUtc(2026, 3, 8, 10, 'America/New_York');
        assert.strictEqual(beforeChange.toISOString(), '2026-03-07T15:00:00.000Z');
        assert.strictEqual(afterChange.toISOString(), '2026-03-08T14:00:00.000Z');
    });

    await runTest('schedule: a time that has already passed today is skipped', () => {
        const slots = scheduler.buildScheduleSlots(7, '2026-11-24', '2026-11-30', 10, {
            timeZone: 'Asia/Kolkata',
            notBefore: new Date('2026-11-24T05:00:00Z') // 10:30 in Kolkata
        });
        assert.strictEqual(slots.length, 6);
        assert.strictEqual(slots[0].toISOString(), '2026-11-25T04:30:00.000Z');
    });

    await runTest('schedule: 8 posts a week adds a second, later slot on the first day', () => {
        const slots = scheduler.buildScheduleSlots(8, '2026-11-24', '2026-11-30', 10, { timeZone: 'UTC' });
        assert.strictEqual(slots.length, 8);
        assert.strictEqual(slots[1].toISOString(), '2026-11-24T14:00:00.000Z');
    });

    // ------------------------------------------------------------------
    // Endpoints: sign-in required, cron secret required, queue management
    // ------------------------------------------------------------------
    const app = require('../index');
    const { createSessionToken, getLinkedInOAuthConfig } = require('../services/oauthService');
    const store = require('../services/publishingStore');

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const cookieFor = (userId) => 'postcraft_session=' + createSessionToken(getLinkedInOAuthConfig(), {
        userId,
        email: userId + '@example.test',
        displayName: userId,
        linkedinMemberId: userId
    });
    const call = async (method, url, { cookie, body, headers } = {}) => {
        const response = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(headers || {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
        let json = null;
        try { json = await response.json(); } catch (error) { /* not json */ }
        return { status: response.status, json };
    };

    try {
        await runTest('endpoints: AI and Telegram routes reject visitors who are not signed in', async () => {
            const attempts = [
                ['POST', '/generate', { startDate: '2026-11-24', endDate: '2026-11-25' }],
                ['POST', '/improve-post', { currentPost: 'x', userRequest: 'y' }],
                ['POST', '/telegram/send-verification', { chatId: '12345' }],
                ['GET', '/model-status'],
                ['POST', '/reset-models', {}]
            ];
            for (const [method, url, body] of attempts) {
                const response = await call(method, url, { body });
                assert.strictEqual(response.status, 401, method + ' ' + url + ' returned ' + response.status);
            }
        });

        await runTest('endpoints: the cron route needs the secret', async () => {
            assert.strictEqual((await call('GET', '/api/cron/publish')).status, 401);
            assert.strictEqual((await call('GET', '/api/cron/publish', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
            const allowed = await call('GET', '/api/cron/publish', { headers: { Authorization: 'Bearer test-cron-secret' } });
            assert.strictEqual(allowed.status, 200);
            assert.strictEqual(allowed.json.success, true);
        });

        await runTest('endpoints: "send to Telegram" cannot be pointed at someone else\'s chat', async () => {
            const response = await call('POST', '/telegram/send-verification', {
                cookie: cookieFor('user_without_telegram'),
                body: { chatId: '999999' }
            });
            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.json.success, false);
            assert.ok(/Link Telegram/i.test(response.json.error), response.json.error);
        });

        // A signed-in user with a connected account, created straight in the local store.
        const alice = cookieFor('alice');
        const aliceContext = { userId: 'alice' };
        await store.saveAccount({
            id: 'account_alice',
            userId: 'alice',
            platform: 'linkedin',
            displayName: 'Alice',
            accessToken: 'not-a-real-token',
            authorUrn: 'urn:li:person:alice',
            status: 'connected',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }, aliceContext);

        const tomorrow = new Date(Date.now() + 24 * HOUR);
        const inTenDays = new Date(Date.now() + 10 * 24 * HOUR);
        const ymd = (date) => date.toISOString().slice(0, 10);
        let scheduleId = '';
        let queue = [];

        await runTest('schedule: the chosen topics and rotation reach the queue (they were ignored before)', async () => {
            const created = await call('POST', '/publishing/schedules', {
                cookie: alice,
                body: {
                    platform: 'linkedin',
                    accountId: 'account_alice',
                    postsPerWeek: 7,
                    preferredHour: 9,
                    startDate: ymd(tomorrow),
                    endDate: ymd(inTenDays),
                    mode: 'rotation',
                    categories: ['dental', 'Electric Vehicles'],
                    timeZone: 'Asia/Kolkata'
                }
            });
            assert.strictEqual(created.status, 200, JSON.stringify(created.json));
            scheduleId = created.json.schedule.id;
            assert.deepStrictEqual(created.json.schedule.categories, ['dental', 'electric vehicles']);

            const overview = await call('GET', '/publishing/overview', { cookie: alice });
            queue = overview.json.queue.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));
            assert.strictEqual(queue.length, 10);
            assert.deepStrictEqual(queue.slice(0, 4).map((item) => item.metadata.category), ['dental', 'electric vehicles', 'dental', 'electric vehicles']);
            // 09:00 in Kolkata is 03:30 UTC.
            assert.ok(queue.every((item) => item.scheduledFor.endsWith('T03:30:00.000Z')), queue[0].scheduledFor);
        });

        await runTest('queue: a post can be moved to another time', async () => {
            const target = new Date(Date.now() + 20 * 24 * HOUR).toISOString();
            const moved = await call('PATCH', '/publishing/queue/' + queue[0].id, { cookie: alice, body: { scheduledFor: target } });
            assert.strictEqual(moved.status, 200, JSON.stringify(moved.json));
            const overview = await call('GET', '/publishing/overview', { cookie: alice });
            const item = overview.json.queue.find((entry) => entry.id === queue[0].id);
            assert.strictEqual(new Date(item.scheduledFor).toISOString(), target);
            assert.strictEqual(item.status, 'scheduled');
        });

        await runTest('queue: writing your own text marks the post as yours', async () => {
            const edited = await call('PATCH', '/publishing/queue/' + queue[1].id, { cookie: alice, body: { content: 'My own words.' } });
            assert.strictEqual(edited.status, 200);
            const overview = await call('GET', '/publishing/overview', { cookie: alice });
            const item = overview.json.queue.find((entry) => entry.id === queue[1].id);
            assert.strictEqual(item.content, 'My own words.');
            assert.strictEqual(item.metadata.contentStatus, 'manually_edited');
            assert.strictEqual(item.metadata.category, 'electric vehicles');
        });

        await runTest('queue: a post can be deleted, and only by its owner', async () => {
            const stranger = await call('DELETE', '/publishing/queue/' + queue[2].id, { cookie: cookieFor('mallory') });
            assert.strictEqual(stranger.status, 404);

            const removed = await call('DELETE', '/publishing/queue/' + queue[2].id, { cookie: alice });
            assert.strictEqual(removed.status, 200);
            const overview = await call('GET', '/publishing/overview', { cookie: alice });
            assert.strictEqual(overview.json.queue.length, 9);
            assert.ok(!overview.json.queue.some((entry) => entry.id === queue[2].id));
        });

        await runTest('schedule: deleting a schedule removes its posts too', async () => {
            const stranger = await call('DELETE', '/publishing/schedules/' + scheduleId, { cookie: cookieFor('mallory') });
            assert.strictEqual(stranger.status, 404);

            const removed = await call('DELETE', '/publishing/schedules/' + scheduleId, { cookie: alice });
            assert.strictEqual(removed.status, 200);
            assert.strictEqual(removed.json.removedQueueItems, 9);
            const overview = await call('GET', '/publishing/overview', { cookie: alice });
            assert.strictEqual(overview.json.schedules.length, 0);
            assert.strictEqual(overview.json.queue.length, 0);
        });
    } finally {
        server.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    const failed = results.filter((result) => !result.ok).length;
    console.log('\nTotal: ' + results.length + '  |  Passed: ' + (results.length - failed) + '  |  Failed: ' + failed);
    process.exit(failed ? 1 : 0);
})();
