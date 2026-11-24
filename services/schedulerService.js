const {
    readState,
    saveSchedule,
    saveQueueItems,
    saveQueueItem,
    updateQueueItemStatus,
    createId,
    getProfile
} = require('./publishingStore');
const { publishToPlatform } = require('./platformPublishers');
const LinkedInPostGenerator = require('../linkedinPostGenerator');
const telegramService = require('./telegramService');

const PENDING_CONTENT_PLACEHOLDER = 'Content will be generated automatically when this scheduled item is published.';
const ROTATING_POST_TYPES = ['service', 'tip', 'motivation', 'ai_tool'];

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

async function createGeneratorForSchedule(schedule) {
    const generator = new LinkedInPostGenerator();
    generator.setPlatform(schedule.platform);
    await generator.setCompanyInfo(
        schedule.companyName,
        schedule.website,
        schedule.services,
        schedule.industry,
        { skipAiHashtags: true }
    );
    return generator;
}

const newsService = require('./newsService');

// True while a queue item has no post text of its own yet and is waiting for
// its owner to pick one of the day's stories on Telegram.
function needsTelegramChoice(queueItem) {
    return (
        !queueItem.content ||
        queueItem.metadata?.contentStatus === 'pending_verification' ||
        String(queueItem.content).includes('Scheduled news post')
    );
}

function needsQueueContent(queueItem) {
    return (
        !queueItem.content ||
        queueItem.content === PENDING_CONTENT_PLACEHOLDER ||
        queueItem.metadata?.contentStatus === 'pending_generation'
    );
}

async function generateQueueContent(generator, schedule, scheduledFor, category = 'tech') {
    try {
        const cat = newsService.normalizeCategory(category) || 'tech';
        const article = await newsService.getArticleForCategory(cat);
        if (!article) {
            throw new Error(`No recent news for ${cat}`);
        }

        const content = await generator.generateNewsPost(new Date(scheduledFor), cat, article);
        return {
            content,
            metadata: {
                category: cat,
                articleTitle: article.title,
                articleLink: article.link,
                articlePublishedAt: article.publishedAt || null,
                contentStatus: 'generated',
                generatedAt: new Date().toISOString()
            }
        };
    } catch (error) {
        return {
            content: PENDING_CONTENT_PLACEHOLDER,
            metadata: {
                category: category || 'tech',
                contentStatus: 'pending_generation'
            }
        };
    }
}

function formatPublishError(error) {
    const responseData = error.response?.data;

    if (typeof responseData === 'string' && responseData.trim()) {
        return {
            message: responseData,
            status: error.response?.status || null
        };
    }

    if (responseData && typeof responseData === 'object') {
        const parts = [responseData.title, responseData.detail].filter(Boolean);
        return {
            message: parts.length ? parts.join(': ') : JSON.stringify(responseData),
            status: error.response?.status || null
        };
    }

    return {
        message: error.message,
        status: error.response?.status || null
    };
}

// ---------------------------------------------------------------------------
// Time zones.
//
// "10:00" on the schedule form means 10:00 on the clock of the person who
// filled it in, not on the server (which runs in UTC on Vercel). The browser
// sends its IANA zone name (e.g. "Asia/Kolkata") and every slot is built as
// that wall-clock time in that zone, then stored as an absolute instant.
// ---------------------------------------------------------------------------
const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function resolveTimeZone(timeZone) {
    const candidate = String(timeZone || '').trim();
    if (candidate) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: candidate });
            return candidate;
        } catch (error) {
            // Unknown zone name: fall through to the server's zone.
        }
    }
    return SERVER_TIME_ZONE;
}

// The calendar date and time shown on a clock in `timeZone` at `instant`.
function wallClockParts(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(new Date(instant));
    const get = (type) => Number(parts.find((part) => part.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// The instant at which a clock in `timeZone` shows the given date and time.
function zonedTimeToUtc(year, month, day, hour, timeZone, minute = 0, second = 0) {
    const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetAt = (instant) => {
        const wall = wallClockParts(instant, timeZone);
        return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instant;
    };
    // Two passes so the result is right on either side of a DST change.
    const firstGuess = asIfUtc - offsetAt(asIfUtc);
    return new Date(asIfUtc - offsetAt(firstGuess));
}

// Accepts "YYYY-MM-DD" (taken as a calendar date in the user's zone) or a
// Date/ISO timestamp (converted to the calendar date in that zone).
function toCalendarDate(value, timeZone) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (match) {
        return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    }
    const date = value ? new Date(value) : new Date();
    const wall = wallClockParts(Number.isNaN(date.getTime()) ? Date.now() : date.getTime(), timeZone);
    return { year: wall.year, month: wall.month, day: wall.day };
}

function addCalendarDays(calendarDate, days) {
    const shifted = new Date(Date.UTC(calendarDate.year, calendarDate.month - 1, calendarDate.day + days));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function compareCalendarDates(a, b) {
    return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

// One slot per day at the preferred hour; the 8th-10th posts of a week go
// out four hours later on the first days of that week.
//   options.timeZone  - IANA zone the dates and hour are expressed in
//   options.notBefore - drop slots at or before this instant (used when a
//                       schedule is created, so today's already-passed hour
//                       does not publish the moment the schedule is saved)
function buildScheduleSlots(postsPerWeek, startDate, endDate, preferredHour, options = {}) {
    const timeZone = resolveTimeZone(options.timeZone);
    const notBefore = options.notBefore ? new Date(options.notBefore).getTime() : null;
    const first = toCalendarDate(startDate, timeZone);
    const last = toCalendarDate(endDate, timeZone);
    const slots = [];

    for (let weekStart = first; compareCalendarDates(weekStart, last) <= 0; weekStart = addCalendarDays(weekStart, 7)) {
        for (let i = 0; i < postsPerWeek; i++) {
            const day = addCalendarDays(weekStart, i % 7);
            if (compareCalendarDates(day, last) > 0) {
                continue;
            }

            const hour = preferredHour + (Math.floor(i / 7) * 4);
            const scheduled = zonedTimeToUtc(day.year, day.month, day.day, hour, timeZone);
            if (notBefore !== null && scheduled.getTime() <= notBefore) {
                continue;
            }
            slots.push(scheduled);
        }
    }

    return slots.sort((a, b) => a.getTime() - b.getTime());
}

async function generateQueueItemsForSchedule(schedule, options = {}) {
    const slots = buildScheduleSlots(
        schedule.postsPerWeek,
        schedule.startDate,
        schedule.endDate,
        schedule.preferredHour || 10,
        { timeZone: schedule.timeZone, notBefore: options.notBefore }
    );
    if (!slots.length) {
        return [];
    }

    const categories = Array.isArray(schedule.categories) && schedule.categories.length > 0
        ? schedule.categories
        : ['tech', 'science', 'dental'];
    const mode = schedule.mode || 'rotation';

    const queueItems = [];
    for (let index = 0; index < slots.length; index += 1) {
        const scheduledFor = slots[index];
        const category = mode === 'block' ? categories[0] : categories[index % categories.length];

        queueItems.push({
            id: createId('queue'),
            userId: schedule.userId,
            scheduleId: schedule.id,
            accountId: schedule.accountId,
            platform: schedule.platform,
            status: 'scheduled',
            scheduledFor: scheduledFor.toISOString(),
            createdAt: new Date().toISOString(),
            content: `Scheduled news post [Category: ${category.toUpperCase()}]. Top 3 news options will be sent to Telegram for verification.`,
            metadata: {
                category,
                contentStatus: 'pending_verification',
                generationMode: mode
            }
        });
    }

    return queueItems;
}

async function generateContentForQueueItem(queueItem, schedule) {
    const generator = await createGeneratorForSchedule(schedule);
    const category = queueItem.metadata?.category || 'tech';
    const generatedItem = await generateQueueContent(
        generator,
        schedule,
        queueItem.scheduledFor,
        category
    );

    queueItem.content = generatedItem.content;
    queueItem.metadata = {
        ...queueItem.metadata,
        ...generatedItem.metadata
    };

    return queueItem;
}

async function hydratePendingQueueItems(queueItems, schedules, context = {}) {
    const pendingItems = (queueItems || []).filter((item) =>
        item.platform === 'linkedin' && needsQueueContent(item)
    );

    if (!pendingItems.length) {
        return queueItems;
    }

    const schedulesById = new Map((schedules || []).map((schedule) => [schedule.id, schedule]));
    const pendingBySchedule = new Map();

    for (const item of pendingItems) {
        const collection = pendingBySchedule.get(item.scheduleId) || [];
        collection.push(item);
        pendingBySchedule.set(item.scheduleId, collection);
    }

    for (const [scheduleId, items] of pendingBySchedule.entries()) {
        const schedule = schedulesById.get(scheduleId);
        if (!schedule) {
            continue;
        }

        const generator = await createGeneratorForSchedule(schedule);

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const category = item.metadata?.category || 'tech';
            const generated = await generateQueueContent(
                generator,
                schedule,
                item.scheduledFor,
                category
            );

            item.content = generated.content;
            item.metadata = {
                ...(item.metadata || {}),
                ...generated.metadata
            };
            item.updatedAt = new Date().toISOString();
            await saveQueueItem(item, context);
        }
    }

    return queueItems;
}

async function createScheduleAndQueue(payload, context = {}) {
    if (payload.platform !== 'linkedin') {
        throw new Error('Only linkedin schedules are supported.');
    }

    // For local auth (localStorage) there is no server-side userId — use the account owner info
    const userId = String(context.userId || '').trim() || 'local';

    const state = await readState(context);
    const account = state.accounts.find((item) => item.id === payload.accountId);
    if (!account) {
        throw new Error('Connected account not found. Connect your LinkedIn account first.');
    }

    if (account.platform !== payload.platform) {
        throw new Error('Selected account does not match the chosen publishing platform.');
    }

    // Dates and the preferred hour are in the user's own time zone.
    const timeZone = resolveTimeZone(payload.timeZone);
    const firstDay = toCalendarDate(payload.startDate || new Date(), timeZone);
    const lastDay = payload.endDate ? toCalendarDate(payload.endDate, timeZone) : addCalendarDays(firstDay, 27);

    if (compareCalendarDates(lastDay, firstDay) < 0) {
        throw new Error('End date must be on or after the start date.');
    }

    const normalizedStartDate = zonedTimeToUtc(firstDay.year, firstDay.month, firstDay.day, 0, timeZone);
    const normalizedEndDate = zonedTimeToUtc(lastDay.year, lastDay.month, lastDay.day, 23, timeZone, 59, 59);

    const categories = (Array.isArray(payload.categories) ? payload.categories : [])
        .map((category) => newsService.normalizeCategory(category))
        .filter(Boolean)
        .slice(0, 14);

    const schedule = {
        id: createId('schedule'),
        userId,
        platform: payload.platform,
        accountId: payload.accountId,
        companyName: payload.companyName || account.displayName || 'My Company',
        website: payload.website || '',
        industry: payload.industry || 'General',
        services: payload.services || [],
        countryCode: payload.countryCode || 'IN',
        mode: payload.mode === 'block' ? 'block' : 'rotation',
        categories: categories.length > 0 ? categories : ['tech', 'science', 'dental'],
        postsPerWeek: payload.postsPerWeek,
        preferredHour: payload.preferredHour || 10,
        startDate: normalizedStartDate.toISOString(),
        endDate: normalizedEndDate.toISOString(),
        active: true,
        createdAt: new Date().toISOString()
    };

    // Slots are built from the calendar dates in the user's zone, and any
    // slot that has already passed today is skipped instead of firing the
    // moment the schedule is saved.
    const queueItems = await generateQueueItemsForSchedule({
        ...schedule,
        timeZone,
        startDate: `${firstDay.year}-${String(firstDay.month).padStart(2, '0')}-${String(firstDay.day).padStart(2, '0')}`,
        endDate: `${lastDay.year}-${String(lastDay.month).padStart(2, '0')}-${String(lastDay.day).padStart(2, '0')}`
    }, { notBefore: new Date() });

    if (!queueItems.length) {
        throw new Error('That date range has no upcoming posting times. Pick a later end date.');
    }

    await saveSchedule(schedule, context);
    await saveQueueItems(queueItems, context);

    return { schedule, queueItems };
}

async function publishQueueItem(queueItemId, context = {}) {
    // Always read from the full state so we can find items regardless of user scope.
    const effectiveContext = context.scope === 'all' || context.localOnly ? context : { scope: 'all' };
    const state = await readState(effectiveContext);
    const queueItem = state.queue.find((item) => item.id === queueItemId);

    if (!queueItem) {
        throw new Error('Queue item not found.');
    }

    if (queueItem.platform !== 'linkedin') {
        throw new Error('Only linkedin queue items can be published.');
    }

    const account = state.accounts.find((item) => item.id === queueItem.accountId);
    if (!account) {
        throw new Error('Connected account not found for this queue item.');
    }

    const schedule = state.schedules.find((item) => item.id === queueItem.scheduleId);
    if (!schedule) {
        throw new Error('Publishing schedule not found for this queue item.');
    }

    if (queueItem.status === 'published') {
        return queueItem;
    }

    if (queueItem.status === 'pending_confirmation') {
        // A confirmation message is already out on Telegram for this item —
        // don't send a second one just because someone clicked "Publish"
        // again in the UI while waiting on a reply.
        return queueItem;
    }

    queueItem.status = 'publishing';
    queueItem.updatedAt = new Date().toISOString();
    await updateQueueItemStatus(queueItem.id, {
        status: queueItem.status,
        updatedAt: queueItem.updatedAt
    }, effectiveContext);

    try {
        if (needsTelegramChoice(queueItem)) {
            const profile = await getProfile(queueItem.userId);

            if (!profile?.telegramChatId) {
                // Don't leave this silently retrying forever — without a
                // linked Telegram chat there's no one to confirm with, so
                // fail it clearly instead of re-triggering every 30s.
                queueItem.status = 'failed';
                queueItem.error = 'No Telegram chat linked. Link Telegram from the Publishing Hub to enable confirmations.';
                queueItem.updatedAt = new Date().toISOString();
                await saveQueueItem(queueItem, effectiveContext);
                return queueItem;
            }

            console.log(`📡 [Scheduler] Sending Telegram confirmation to user ${queueItem.userId} for queue item ${queueItem.id}...`);

            // Stories this person has already been offered or has posted, so
            // today's options are always new ones.
            const usedLinks = new Set();
            state.queue
                .filter((item) => item.userId === queueItem.userId && item.id !== queueItem.id)
                .forEach((item) => {
                    if (item.metadata?.articleLink) usedLinks.add(item.metadata.articleLink);
                    (item.metadata?.telegramOptions || []).forEach((option) => {
                        if (option?.link) usedLinks.add(option.link);
                    });
                });

            const { options, delivered } = await telegramService.sendQueueConfirmation(
                queueItem,
                schedule,
                profile.telegramChatId,
                { excludeUrls: usedLinks }
            );

            if (!options.length || !delivered) {
                // Nothing was sent, so there is nothing to wait for: fail
                // clearly instead of sitting in "awaiting Telegram" forever.
                queueItem.status = 'failed';
                queueItem.error = !options.length
                    ? `No recent news could be loaded for "${queueItem.metadata?.category || 'this topic'}". Use Publish Now to try again, or write the post yourself with Edit.`
                    : 'The Telegram message could not be delivered. Open the bot chat, press Start, then use Publish Now to try again.';
                queueItem.updatedAt = new Date().toISOString();
                await saveQueueItem(queueItem, effectiveContext);
                return queueItem;
            }

            // pending_confirmation is intentionally its own status, distinct
            // from 'scheduled' — publishDueQueueItems only looks for items
            // still in 'scheduled', so this item won't get re-processed
            // (and re-sent to Telegram) on every scheduler tick while it
            // waits for the person to tap a button.
            queueItem.status = 'pending_confirmation';
            queueItem.metadata = {
                ...(queueItem.metadata || {}),
                telegramOptions: options,
                telegramChatId: profile.telegramChatId,
                verificationSentAt: new Date().toISOString()
            };
            queueItem.updatedAt = new Date().toISOString();
            await saveQueueItem(queueItem, effectiveContext);
            return queueItem;
        }

        const result = await publishToPlatform(queueItem.platform, account, queueItem);
        queueItem.status = 'published';
        queueItem.publishedAt = new Date().toISOString();
        queueItem.providerId = result.providerId;
        queueItem.providerResponse = result.providerResponse;
        queueItem.error = null;
        queueItem.errorStatus = null;
    } catch (error) {
        const publishError = formatPublishError(error);
        queueItem.status = 'failed';
        queueItem.error = publishError.message;
        queueItem.errorStatus = publishError.status;
    }

    queueItem.updatedAt = new Date().toISOString();
    await saveQueueItem(queueItem, effectiveContext);
    return queueItem;
}

async function publishDueQueueItems(options = {}, context = {}) {
    const limit = Number(options.limit || 20);
    const now = options.now ? new Date(options.now) : new Date();
    const effectiveContext = resolveSchedulerContext(context);
    const state = await readState(effectiveContext);

    // Where the automatic check only runs once a day (Vercel Hobby cron),
    // posts that still need a Telegram choice are sent for approval up to
    // `confirmationLookaheadMs` early, so the day's options arrive in the
    // morning and each post goes out when its option is tapped. Posts whose
    // text is already written are never published early.
    const lookaheadMs = Math.max(0, Number(options.confirmationLookaheadMs || 0));
    const isDue = (item) => {
        const scheduledTime = new Date(item.scheduledFor).getTime();
        if (scheduledTime <= now.getTime()) {
            return true;
        }
        return lookaheadMs > 0 && needsTelegramChoice(item) && scheduledTime <= now.getTime() + lookaheadMs;
    };

    const dueItems = state.queue
        .filter((item) =>
            item.platform === 'linkedin' &&
            item.status === 'scheduled' &&
            isDue(item)
        )
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
        .slice(0, limit);

    const items = [];
    for (const item of dueItems) {
        items.push(await publishQueueItem(item.id, effectiveContext));
    }

    return {
        processedCount: items.length,
        publishedCount: items.filter((entry) => entry.status === 'published').length,
        failedCount: items.filter((entry) => entry.status === 'failed').length,
        items
    };
}

function resolveSchedulerContext(context = {}) {
    if (context.scope === 'all') {
        return context;
    }

    if (context.userId) {
        return context;
    }

    return { scope: 'all' };
}

let schedulerStarted = false;
let isSchedulerPublishing = false;

function startScheduler() {
    if (schedulerStarted) {
        return;
    }

    schedulerStarted = true;
    setInterval(async () => {
        if (isSchedulerPublishing) {
            return;
        }

        isSchedulerPublishing = true;
        try {
            await publishDueQueueItems({}, { scope: 'all' });
        } catch (error) {
            console.error('Scheduler error:', error.message);
        } finally {
            isSchedulerPublishing = false;
        }
    }, 30000);
}

module.exports = {
    createScheduleAndQueue,
    generateQueueItemsForSchedule,
    generateContentForQueueItem,
    hydratePendingQueueItems,
    publishQueueItem,
    publishDueQueueItems,
    startScheduler,
    buildScheduleSlots,
    zonedTimeToUtc,
    needsTelegramChoice
};
