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

function needsQueueContent(queueItem) {
    return (
        !queueItem.content ||
        queueItem.content === PENDING_CONTENT_PLACEHOLDER ||
        queueItem.metadata?.contentStatus === 'pending_generation'
    );
}

async function generateQueueContent(generator, schedule, scheduledFor, category = 'tech') {
    try {
        const cat = String(category || queueItem?.metadata?.category || 'tech').toLowerCase();
        const article = await newsService.getArticleForCategory(cat);
        const prompt = `You are a professional LinkedIn content expert. Create an engaging, professional LinkedIn post based on this news:

Title: ${article.title}
Summary: ${article.summary}
Source Link: ${article.link}

Format with line breaks, 2-3 relevant hashtags, and a call-to-action at the end.`;

        const content = await generator.generateContentWithAI(prompt);
        return {
            content: content || `${article.title}\n\n${article.summary}\n\nRead more: ${article.link}`,
            metadata: {
                category: cat,
                articleTitle: article.title,
                articleLink: article.link,
                contentStatus: content ? 'generated' : 'news_fallback',
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

function buildScheduleSlots(postsPerWeek, startDate, endDate, preferredHour) {
    const slots = [];
    const scheduleStart = startOfDay(startDate);
    const scheduleEnd = endOfDay(endDate);
    let weekStart = new Date(scheduleStart);

    while (weekStart <= scheduleEnd) {
        for (let i = 0; i < postsPerWeek; i++) {
            const dayOffset = i % 7;
            const slotOffset = Math.floor(i / 7);
            const scheduled = new Date(weekStart);
            scheduled.setDate(scheduled.getDate() + dayOffset);
            scheduled.setHours(preferredHour + (slotOffset * 4), 0, 0, 0);

            if (scheduled >= scheduleStart && scheduled <= scheduleEnd) {
                slots.push(scheduled);
            }
        }

        weekStart = addDays(weekStart, 7);
    }

    return slots.sort((a, b) => a.getTime() - b.getTime());
}

async function generateQueueItemsForSchedule(schedule) {
    const slots = buildScheduleSlots(
        schedule.postsPerWeek,
        schedule.startDate,
        schedule.endDate,
        schedule.preferredHour || 10
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

    const normalizedStartDate = startOfDay(payload.startDate || new Date());
    const normalizedEndDate = endOfDay(payload.endDate || addDays(normalizedStartDate, 27));

    if (normalizedEndDate < normalizedStartDate) {
        throw new Error('End date must be on or after the start date.');
    }

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
        mode: payload.mode || 'rotation',
        categories: Array.isArray(payload.categories) && payload.categories.length > 0 ? payload.categories : ['tech', 'science', 'dental'],
        postsPerWeek: payload.postsPerWeek,
        preferredHour: payload.preferredHour || 10,
        startDate: normalizedStartDate.toISOString(),
        endDate: normalizedEndDate.toISOString(),
        active: true,
        createdAt: new Date().toISOString()
    };

    const queueItems = await generateQueueItemsForSchedule({
        ...schedule,
        startDate: new Date(schedule.startDate),
        endDate: new Date(schedule.endDate)
    });

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
        if (!queueItem.content || queueItem.metadata?.contentStatus === 'pending_verification' || queueItem.content.includes('Scheduled news post')) {
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

            const options = await telegramService.sendQueueConfirmation(queueItem, schedule, profile.telegramChatId);

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

    const dueItems = state.queue
        .filter((item) =>
            item.platform === 'linkedin' &&
            item.status === 'scheduled' &&
            new Date(item.scheduledFor).getTime() <= now.getTime()
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
    startScheduler
};
