const axios = require('axios');
const newsService = require('./newsService');
const LinkedInPostGenerator = require('../linkedinPostGenerator');
const {
    readState,
    updateQueueItem,
    getProfileByTelegramChatId,
    linkTelegramChatByCode
} = require('./publishingStore');
const { publishToPlatform } = require('./platformPublishers');
const draftFlow = require('./draftFlow');
const playbookService = require('./playbookService');
const contentSettings = require('../config/contentSettings');

const STRUCTURE_LABELS = {
    contrarian: 'contrarian take',
    story_lesson: 'story, then lesson',
    three_point: 'three-point breakdown',
    question_led: 'question-led',
    before_after: 'before / after'
};
const HOOK_LABELS = { number: 'opens with a number', conflict: 'opens with a conflict', claim: 'opens with a claim' };
const LINK_LABELS = { none: 'no link', first_comment: 'link in the first comment', in_body: 'link in the post' };

const DEFAULT_CATEGORIES = ['tech', 'science', 'dental'];
// Telegram re-sends an update when a reply is slow. Remember recent ones so
// a repeat cannot redraft or republish twice.
const seenUpdateIds = new Set();

class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN || '';
        this.botUsername = 'linked_automation_bot';
        this.baseUrl = `https://api.telegram.org/bot${this.token}`;
        this.lastUpdateId = 0;
        this.isPolling = false;
        // Ad-hoc demo state only (used by the public, unauthenticated
        // generator.html "send top 3 to Telegram" button). Nothing that
        // touches real account/schedule/queue data uses this.
        this.activeChatIds = new Set();
        this.pendingVerifications = new Map(); // chatId => { date, options, companyContext }
    }

    isConfigured() {
        return Boolean(this.token);
    }

    getDeepLink(code) {
        return `https://t.me/${this.botUsername}?start=${encodeURIComponent(code)}`;
    }

    async setupWebhook(siteUrl) {
        if (!this.isConfigured()) return null;
        const targetUrl = `${String(siteUrl || '').replace(/\/+$/, '')}/api/telegram/webhook`;
        try {
            const response = await axios.get(`${this.baseUrl}/setWebhook`, { params: { url: targetUrl } });
            console.log(`🤖 [TelegramService] Registered Telegram Webhook to ${targetUrl}:`, response.data);
            return response.data;
        } catch (error) {
            console.error('⚠️ [TelegramService] Failed to set Webhook:', error.response?.data || error.message);
            return null;
        }
    }

    async sendMessage(chatId, text, options = {}) {
        if (!chatId) return null;
        try {
            const response = await axios.post(`${this.baseUrl}/sendMessage`, {
                chat_id: chatId,
                text,
                disable_web_page_preview: false,
                ...options
            });
            return response.data;
        } catch (error) {
            console.error(`⚠️ [TelegramService] Error sending message to ${chatId}:`, error.response?.data || error.message);
            return null;
        }
    }

    async answerCallbackQuery(callbackQueryId, text = '') {
        try {
            await axios.post(`${this.baseUrl}/answerCallbackQuery`, {
                callback_query_id: callbackQueryId,
                text,
                show_alert: false
            });
        } catch (error) {
            console.error('⚠️ [TelegramService] Error answering callback query:', error.response?.data || error.message);
        }
    }

    // Up to three recent stories, newest first, skipping anything in
    // options.excludeUrls. One category (or custom topic) gives its three
    // freshest stories; several categories give the freshest story of each.
    // Returns fewer than three (or none) when the news cannot be loaded:
    // there are no made-up placeholder headlines.
    async pickTop3Articles(categoryOrCategories, options = {}) {
        const excludeUrls = options.excludeUrls || new Set();
        const requested = (Array.isArray(categoryOrCategories) ? categoryOrCategories : [categoryOrCategories])
            .map((category) => newsService.normalizeCategory(category))
            .filter(Boolean);
        const categories = requested.length ? [...new Set(requested)] : DEFAULT_CATEGORIES;

        if (categories.length === 1) {
            return newsService.getFreshArticles(categories[0], { excludeUrls, limit: 3 });
        }

        const results = [];
        const taken = new Set(excludeUrls);
        // Round-robin across the categories until there are three stories.
        for (let round = 0; round < 3 && results.length < 3; round += 1) {
            for (const category of categories) {
                if (results.length >= 3) break;
                const [article] = await newsService.getFreshArticles(category, { excludeUrls: taken, limit: 1 });
                if (article) {
                    taken.add(article.link);
                    results.push(article);
                }
            }
        }
        return results;
    }

    describeAge(article) {
        const hours = newsService.ageInHours(article);
        if (!Number.isFinite(hours)) return '';
        if (hours < 1) return 'just now';
        if (hours < 24) return `${Math.round(hours)}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    }

    // ------------------------------------------------------------------
    // Real flow: a scheduled queue item is due, and its owner has a linked
    // Telegram chat. Send them up to 3 real candidate stories as tappable
    // buttons tied to THIS queue item's id — not a plain "reply 1/2/3",
    // which would be ambiguous if the same person has more than one item
    // awaiting confirmation at once.
    //
    // Returns { options, delivered }. `options` is empty when no recent
    // news could be loaded; `delivered` is false when Telegram refused the
    // message. The caller must not wait for a reply in either case.
    // ------------------------------------------------------------------
    async sendQueueConfirmation(queueItem, schedule, chatId, options = {}) {
        const targetCategory = queueItem.metadata?.category || schedule.categories;
        const articles = await this.pickTop3Articles(targetCategory, { excludeUrls: options.excludeUrls });
        if (!articles.length) {
            return { options: [], delivered: false };
        }

        const lines = [
            'PostCraft AI \u2014 choose today\'s LinkedIn post',
            `Company: ${schedule.companyName || 'Your company'}`,
            ''
        ];
        articles.forEach((article, index) => {
            const age = this.describeAge(article);
            lines.push(`${index + 1}. [${String(article.category || '').toUpperCase()}] ${article.title}`);
            lines.push([article.source, age].filter(Boolean).join(' \u00b7 '));
            if (article.summary && article.summary !== article.title) {
                lines.push(String(article.summary).slice(0, 160));
            }
            lines.push('');
        });
        lines.push('Tap a button below to generate and publish that post.');

        const keyboard = {
            inline_keyboard: [articles.map((_, index) => ({
                text: `Choose ${index + 1}`,
                callback_data: `qc:${queueItem.id}:${index}`
            }))]
        };

        const sent = await this.sendMessage(chatId, lines.join('\n'), { reply_markup: keyboard });

        return { options: articles, delivered: Boolean(sent) };
    }

    // ------------------------------------------------------------------
    // Draft approval flow: three full drafts, each with its quality score,
    // each with its own Approve button. Nothing is published until one of
    // those buttons is tapped.
    // Returns true when the drafts reached the chat.
    // ------------------------------------------------------------------
    async sendDraftOptions(chatId, queueItem, schedule, prepared) {
        const when = new Date(queueItem.scheduledFor).toLocaleString('en-IN', {
            timeZone: contentSettings.get().timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
        });
        const dryRun = contentSettings.get().dryRun ? '\nDRY RUN: approving will not publish anything.' : '';
        const intro = await this.sendMessage(chatId, [
            `PostCraft AI — ${prepared.drafts.length} drafts for ${when}`,
            `Niche: ${prepared.topic}`,
            `Link this time: ${LINK_LABELS[prepared.linkMode] || prepared.linkMode}${dryRun}`
        ].join('\n'));
        if (!intro) {
            return false;
        }

        for (let index = 0; index < prepared.drafts.length; index += 1) {
            const draft = prepared.drafts[index];
            const score = draft.meta.score;
            const story = (prepared.stories || []).find((item) => item.link === draft.source_url);
            const flags = [...score.bannedHits.map((hit) => `banned phrase: ${hit}`), ...score.issues];
            (score.factProblems || []).forEach((problem) => flags.unshift(`fact check: ${problem}`));

            const header = [
                `Draft ${index + 1} of ${prepared.drafts.length} · ${STRUCTURE_LABELS[draft.meta.structure] || draft.meta.structure} · ${HOOK_LABELS[draft.meta.hookType] || draft.meta.hookType}`,
                `Score ${score.overall}/10 ${score.passed ? 'PASS' : 'BELOW THE BAR'} (hook ${score.hook} · specific ${score.specificity} · opinion ${score.opinion} · original ${score.originality})`,
                ...(flags.length ? [`Check: ${flags.join('; ')}`] : []),
                ...(story ? [`Story: ${story.title}${story.source ? ` (${story.source})` : ''}`] : [])
            ].join('\n');

            await this.sendMessage(chatId, `${header}\n\n${String(draft.final_text).slice(0, 3300)}`, {
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: [[{ text: `Approve draft ${index + 1}`, callback_data: `qd:${queueItem.id}:${index}` }]] }
            });
        }

        await this.sendMessage(chatId, 'Want your own point in it? Reply:\nmy angle: <one line in your words>\nand all drafts are rewritten around that line.\n\nNothing is published until you approve a draft.', {
            reply_markup: { inline_keyboard: [[{ text: 'Skip this post', callback_data: `qx:${queueItem.id}` }]] }
        });
        return true;
    }

    // Loads the queue item a button belongs to and checks that the person
    // tapping it owns it. Returns null (after answering) if anything is off.
    async loadOwnedPendingItem(chatId, callbackQueryId, queueItemId) {
        const profile = await getProfileByTelegramChatId(chatId);
        if (!profile) {
            await this.answerCallbackQuery(callbackQueryId, 'Your Telegram is not linked to a PostCraft AI account.');
            return null;
        }

        const state = await readState({ scope: 'all' });
        const queueItem = state.queue.find((item) => item.id === queueItemId);
        if (!queueItem) {
            await this.answerCallbackQuery(callbackQueryId, 'This post no longer exists.');
            return null;
        }
        if (queueItem.userId !== profile.id) {
            await this.answerCallbackQuery(callbackQueryId, 'This post does not belong to your account.');
            return null;
        }
        if (queueItem.status !== 'pending_confirmation') {
            await this.answerCallbackQuery(callbackQueryId, `Already ${queueItem.status}.`);
            return null;
        }
        return { profile, state, queueItem };
    }

    async handleDraftApproval({ chatId, callbackQueryId, queueItemId, choiceIndex }) {
        try {
            const loaded = await this.loadOwnedPendingItem(chatId, callbackQueryId, queueItemId);
            if (!loaded) return;
            const { profile, state, queueItem } = loaded;

            const account = state.accounts.find((item) => item.id === queueItem.accountId);
            if (!account) {
                await this.answerCallbackQuery(callbackQueryId, 'Connected LinkedIn account not found.');
                return;
            }

            await this.answerCallbackQuery(callbackQueryId, `Publishing draft ${choiceIndex + 1}...`);

            try {
                const result = await draftFlow.approveDraft({ queueItem, account, choiceIndex });
                await updateQueueItem(queueItem.id, result.patch, { userId: profile.id });
                await this.sendMessage(chatId, result.dryRun
                    ? `DRY RUN — draft ${choiceIndex + 1} was approved but NOT published.`
                    : `Published draft ${choiceIndex + 1} to LinkedIn.${result.note ? `\n\n${result.note}` : ''}\n\nAdd its impressions and reactions in the Publishing Hub after a day or two, so the system can learn what works.`,
                { disable_web_page_preview: true });
            } catch (publishError) {
                const message = publishError.response?.data?.message || publishError.message;
                await updateQueueItem(queueItem.id, { status: 'failed', error: message, updatedAt: new Date().toISOString() }, { userId: profile.id });
                await this.sendMessage(chatId, `Publishing to LinkedIn failed: ${message}`);
            }
        } catch (error) {
            console.error('[TelegramService] Error approving draft:', error.message);
            await this.answerCallbackQuery(callbackQueryId, 'Something went wrong.');
        }
    }

    async handleDraftSkip({ chatId, callbackQueryId, queueItemId }) {
        try {
            const loaded = await this.loadOwnedPendingItem(chatId, callbackQueryId, queueItemId);
            if (!loaded) return;
            const { profile, queueItem } = loaded;
            const metadata = { ...(queueItem.metadata || {}) };
            delete metadata.drafts;
            delete metadata.stories;
            await updateQueueItem(queueItem.id, {
                status: 'failed',
                error: 'Skipped by you.',
                metadata,
                updatedAt: new Date().toISOString()
            }, { userId: profile.id });
            await this.answerCallbackQuery(callbackQueryId, 'Skipped.');
            await this.sendMessage(chatId, 'Skipped. Nothing was published for this slot.');
        } catch (error) {
            console.error('[TelegramService] Error skipping draft:', error.message);
            await this.answerCallbackQuery(callbackQueryId, 'Something went wrong.');
        }
    }

    // "my angle: ..." - rewrite the waiting drafts around the user's own line.
    async handleMyAngle(chatId, angle) {
        const profile = await getProfileByTelegramChatId(chatId);
        if (!profile) {
            await this.sendMessage(chatId, 'Link this chat from the Publishing Hub first.');
            return;
        }

        const state = await readState({ scope: 'all' });
        const waiting = state.queue
            .filter((item) => item.userId === profile.id && item.status === 'pending_confirmation' && (item.metadata?.drafts || []).length)
            .sort((a, b) => new Date(b.metadata.verificationSentAt || 0) - new Date(a.metadata.verificationSentAt || 0))[0];

        if (!waiting) {
            await this.sendMessage(chatId, 'There are no drafts waiting for approval right now. Your angle is used when the next set of drafts arrives - reply to those.');
            return;
        }

        await this.sendMessage(chatId, 'Rewriting the drafts around your line...');
        const prepared = await draftFlow.prepareDrafts({
            queueItem: waiting,
            state,
            options: { myAngle: angle, stories: waiting.metadata.stories || [], linkMode: waiting.metadata.linkMode }
        });

        if (!prepared.drafts.length) {
            await this.sendMessage(chatId, `Could not rewrite the drafts: ${prepared.reason} The earlier drafts are still valid.`);
            return;
        }

        await updateQueueItem(waiting.id, {
            metadata: { ...waiting.metadata, drafts: prepared.drafts, myAngle: angle, verificationSentAt: new Date().toISOString() },
            updatedAt: new Date().toISOString()
        }, { userId: profile.id });

        const schedule = state.schedules.find((item) => item.id === waiting.scheduleId) || {};
        await this.sendDraftOptions(chatId, waiting, schedule, prepared);
    }

    // /refresh - research the current state of LinkedIn reach now.
    async handleRefreshCommand(chatId) {
        const profile = await getProfileByTelegramChatId(chatId);
        if (!profile) {
            await this.sendMessage(chatId, 'Link this chat from the Publishing Hub first.');
            return;
        }

        await this.sendMessage(chatId, 'Researching what is working on LinkedIn right now. This takes up to a minute...');
        const result = await playbookService.refreshPlaybook({ generator: new LinkedInPostGenerator() });
        await this.sendMessage(chatId, this.formatPlaybookUpdate(result), { disable_web_page_preview: true });
    }

    formatPlaybookUpdate(result, flags = []) {
        if (!result.ok && !result.playbook) {
            return `Playbook not refreshed. ${result.reason}`;
        }
        const playbook = result.playbook;
        const lines = [
            `Playbook refreshed (${playbook.version})`,
            `${playbook.researched.searches} searches, ${playbook.researched.pagesRead} pages read. Overall confidence: ${playbook.confidence}.`,
            '',
            'What changed:',
            ...result.changes.map((change) => `- ${change}`)
        ];
        if (flags.length) {
            lines.push('', 'Your own results disagree with the playbook:', ...flags.map((flag) => `- ${flag}`));
        }
        if (!result.ok) {
            lines.push('', `Not saved: ${result.reason}`);
        }
        return lines.join('\n').slice(0, 3900);
    }

    async handlePlaybookCommand(chatId) {
        const playbook = await playbookService.getPlaybook();
        const lines = [
            `Playbook in use: ${playbook.version}${playbook.createdAt ? ` (${String(playbook.createdAt).slice(0, 10)})` : ' (built-in defaults, no research run yet)'}`,
            `Length ${playbook.length_range.min}-${playbook.length_range.max} characters · hashtags ${playbook.hashtag_policy.min}-${playbook.hashtag_policy.max} · link default: ${playbook.link_policy.default_mode} (${playbook.link_policy.status})`,
            '',
            ...playbook.rules.slice(0, 10).map((rule) => `- [${rule.status}, ${rule.confidence}] ${rule.text}`),
            '',
            'Send /refresh to research again now.'
        ];
        await this.sendMessage(chatId, lines.join('\n').slice(0, 3900), { disable_web_page_preview: true });
    }

    async handleQueueConfirmationCallback({ chatId, callbackQueryId, queueItemId, choiceIndex }) {
        try {
            const profile = await getProfileByTelegramChatId(chatId);
            if (!profile) {
                await this.answerCallbackQuery(callbackQueryId, 'Your Telegram is not linked to a PostCraft AI account.');
                return;
            }

            // scope:'all' because the scheduler stores queue items across
            // every user — we filter to this one item, then verify below
            // that it actually belongs to the person who tapped the button.
            const state = await readState({ scope: 'all' });
            const queueItem = state.queue.find((item) => item.id === queueItemId);

            if (!queueItem) {
                await this.answerCallbackQuery(callbackQueryId, 'This post no longer exists.');
                return;
            }

            if (queueItem.userId !== profile.id) {
                // Someone else's callback_data somehow reached this chat — never
                // act on a queue item that doesn't belong to the linked profile.
                await this.answerCallbackQuery(callbackQueryId, 'This post does not belong to your account.');
                return;
            }

            if (queueItem.status !== 'pending_confirmation') {
                await this.answerCallbackQuery(callbackQueryId, `Already ${queueItem.status}.`);
                return;
            }

            const options = queueItem.metadata?.telegramOptions || [];
            const selectedArticle = options[choiceIndex];
            if (!selectedArticle) {
                await this.answerCallbackQuery(callbackQueryId, 'Invalid choice.');
                return;
            }

            await this.answerCallbackQuery(callbackQueryId, `Generating choice ${choiceIndex + 1}...`);
            await this.sendMessage(chatId, `Generating your post from "${selectedArticle.title}"...`);

            const schedule = state.schedules.find((item) => item.id === queueItem.scheduleId);
            const account = state.accounts.find((item) => item.id === queueItem.accountId);

            if (!schedule || !account) {
                await this.sendMessage(chatId, 'Could not find the schedule or connected account for this post.');
                return;
            }

            const generator = new LinkedInPostGenerator();
            await generator.setCompanyInfo(schedule.companyName, schedule.website, schedule.services, schedule.industry, { skipAiHashtags: true });
            const generatedPost = await generator.generateNewsPost(new Date(queueItem.scheduledFor), selectedArticle.category, selectedArticle);

            const patch = {
                content: generatedPost,
                metadata: {
                    ...(queueItem.metadata || {}),
                    chosenOption: choiceIndex + 1,
                    // Recorded so this story is never offered again.
                    articleTitle: selectedArticle.title,
                    articleLink: selectedArticle.link,
                    articlePublishedAt: selectedArticle.publishedAt || null,
                    contentStatus: 'generated',
                    confirmedAt: new Date().toISOString()
                }
            };

            try {
                const publishResult = await publishToPlatform('linkedin', account, { content: generatedPost });
                patch.status = 'published';
                patch.publishedAt = new Date().toISOString();
                patch.providerId = publishResult.providerId || null;
                patch.providerResponse = publishResult.providerResponse || null;
                patch.error = null;
                patch.errorStatus = null;

                await updateQueueItem(queueItem.id, patch, { userId: profile.id });
                await this.sendMessage(chatId, `Published to LinkedIn!\n\n${generatedPost}`);
            } catch (publishError) {
                patch.status = 'failed';
                patch.error = publishError.response?.data?.message || publishError.message;
                await updateQueueItem(queueItem.id, patch, { userId: profile.id });
                await this.sendMessage(chatId, `Generated the post, but publishing to LinkedIn failed: ${patch.error}`);
            }
        } catch (error) {
            console.error('⚠️ [TelegramService] Error handling queue confirmation:', error.message);
            await this.answerCallbackQuery(callbackQueryId, 'Something went wrong.');
        }
    }

    // ------------------------------------------------------------------
    // Ad-hoc demo flow: used by the public Generator page's "send top 3 to
    // Telegram" button, and by /verify for a chat that hasn't linked a
    // PostCraft AI account. Purely illustrative — does not touch any
    // schedule/queue data, and asks the person to type a chat id (or picks
    // the most recently active chat) rather than looking anything up.
    // ------------------------------------------------------------------
    async sendTop3Verification(targetChatId = null, companyContext = {}) {
        let chatId = targetChatId;
        if (!chatId && this.activeChatIds.size > 0) {
            chatId = Array.from(this.activeChatIds)[0];
        }

        if (!chatId) {
            return {
                success: false,
                error: `No active Telegram chat found. Please send /start to @${this.botUsername} first.`
            };
        }

        try {
            const options = await this.pickTop3Articles(DEFAULT_CATEGORIES);
            if (!options.length) {
                return { success: false, error: 'No recent news could be loaded right now. Please try again in a few minutes.' };
            }

            this.pendingVerifications.set(String(chatId), {
                date: new Date().toISOString(),
                options,
                companyContext
            });

            const lines = ['PostCraft AI Daily News Verification', '', 'Please choose Option 1, 2, or 3 for today\'s LinkedIn post:', ''];
            options.forEach((article, index) => {
                lines.push(`${index + 1}. [${String(article.category || '').toUpperCase()}]`);
                lines.push(`Headline: ${article.title}`);
                lines.push(`Summary: ${String(article.summary || '').slice(0, 160)}...`);
                lines.push('');
            });
            lines.push('----------------------------------');
            lines.push('Reply with 1, 2, or 3 to generate a post (demo only \u2014 not published).');

            const sent = await this.sendMessage(chatId, lines.join('\n'));
            if (!sent) {
                return { success: false, error: `Telegram could not deliver the message. Open @${this.botUsername}, press Start, then try again.` };
            }
            return { success: true, options };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async handleDemoOptionSelection(chatId, choiceNumber) {
        const strChatId = String(chatId);
        const session = this.pendingVerifications.get(strChatId);

        if (!session) {
            await this.sendMessage(chatId, 'No pending verification session found. Reply /verify to get new options.');
            return;
        }

        const choiceIndex = choiceNumber - 1;
        if (choiceIndex < 0 || choiceIndex >= session.options.length) {
            await this.sendMessage(chatId, 'Invalid choice. Please reply with 1, 2, or 3.');
            return;
        }

        const selectedArticle = session.options[choiceIndex];
        await this.sendMessage(chatId, `Generating a demo post for "${selectedArticle.title}"...`);

        try {
            const generator = new LinkedInPostGenerator();
            if (session.companyContext?.companyName) {
                await generator.setCompanyInfo(
                    session.companyContext.companyName,
                    session.companyContext.website || '',
                    session.companyContext.services || [],
                    session.companyContext.industry || ''
                );
            }

            const generatedPost = await generator.generateNewsPost(new Date(), selectedArticle.category, selectedArticle);
            await this.sendMessage(chatId, `Demo post (not published):\n\n${generatedPost}\n\nSign in to PostCraft AI and link this chat from the Publishing Hub to enable real scheduled confirmations.`);
            this.pendingVerifications.delete(strChatId);
        } catch (error) {
            await this.sendMessage(chatId, `Error generating post: ${error.message}`);
        }
    }

    async processSingleUpdate(update) {
        if (!update) return;
        if (update.update_id != null) {
            if (seenUpdateIds.has(update.update_id)) return;
            seenUpdateIds.add(update.update_id);
            if (seenUpdateIds.size > 500) {
                seenUpdateIds.delete(seenUpdateIds.values().next().value);
            }
        }

        if (update.callback_query) {
            const cq = update.callback_query;
            const chatId = cq.message?.chat?.id;
            const data = String(cq.data || '');
            if (chatId && data.startsWith('qd:')) {
                const [, queueItemId, choiceIndexStr] = data.split(':');
                await this.handleDraftApproval({ chatId, callbackQueryId: cq.id, queueItemId, choiceIndex: Number(choiceIndexStr) });
            } else if (chatId && data.startsWith('qx:')) {
                await this.handleDraftSkip({ chatId, callbackQueryId: cq.id, queueItemId: data.split(':')[1] });
            } else if (chatId && data.startsWith('qc:')) {
                const [, queueItemId, choiceIndexStr] = data.split(':');
                await this.handleQueueConfirmationCallback({
                    chatId,
                    callbackQueryId: cq.id,
                    queueItemId,
                    choiceIndex: Number(choiceIndexStr)
                });
            } else {
                await this.answerCallbackQuery(cq.id);
            }
            return;
        }

        const message = update.message;
        if (!message || !message.chat) return;

        const chatId = message.chat.id;
        this.activeChatIds.add(chatId);
        const text = (message.text || '').trim();

        console.log(`📩 [TelegramService] Incoming message from ${chatId}: "${text}"`);

        if (text.startsWith('/start')) {
            const code = text.slice('/start'.length).trim();
            if (code) {
                const profile = await linkTelegramChatByCode(code, chatId);
                if (profile) {
                    await this.sendMessage(chatId, `Linked! This chat is now connected to your PostCraft AI account${profile.displayName ? ` (${profile.displayName})` : ''}.\n\nScheduled posts will be sent here for your confirmation before they publish.`);
                } else {
                    await this.sendMessage(chatId, 'That link code is invalid or has expired. Generate a new one from the Publishing Hub in PostCraft AI.');
                }
            } else {
                await this.sendMessage(chatId, 'Welcome to PostCraft AI!\n\nTo receive scheduled-post confirmations here, sign in to PostCraft AI, open the Publishing Hub, and tap "Link Telegram" — it will open a link back to this chat.\n\nYou can also reply /verify to try a demo with sample news topics.');
            }
        } else if (/^my angle\s*[:\-]/i.test(text)) {
            const angle = text.replace(/^my angle\s*[:\-]\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 300);
            if (angle.length < 8) {
                await this.sendMessage(chatId, 'Write your angle after the colon, for example:\nmy angle: funding news matters less than who is actually hiring.');
            } else {
                await this.handleMyAngle(chatId, angle);
            }
        } else if (text === '/refresh') {
            await this.handleRefreshCommand(chatId);
        } else if (text === '/playbook') {
            await this.handlePlaybookCommand(chatId);
        } else if (text === '/verify' || text === '/news') {
            const profile = await getProfileByTelegramChatId(chatId);
            if (profile) {
                await this.sendMessage(chatId, 'Your linked account only receives confirmations for posts that are actually due — check the Publishing Hub for your queue.');
            } else {
                await this.sendTop3Verification(chatId);
            }
        } else if (text === '1' || text === '2' || text === '3') {
            // Replies only mean something for the generator's "send top 3"
            // preview; scheduled posts are confirmed with the buttons.
            const profile = await getProfileByTelegramChatId(chatId);
            if (!profile || this.pendingVerifications.has(String(chatId))) {
                await this.handleDemoOptionSelection(chatId, parseInt(text, 10));
            }
        }
    }

    async handleWebhookUpdate(update) {
        return this.processSingleUpdate(update);
    }

    async pollUpdates() {
        if (!this.isConfigured()) {
            console.log('ℹ️ [TelegramService] TELEGRAM_BOT_TOKEN not configured. Polling disabled.');
            return;
        }

        this.isPolling = true;
        console.log(`🤖 [TelegramService] Telegram Bot polling started (@${this.botUsername})`);

        while (this.isPolling) {
            try {
                const response = await axios.get(`${this.baseUrl}/getUpdates`, {
                    params: { offset: this.lastUpdateId + 1, timeout: 10 },
                    timeout: 15000
                });

                const updates = response.data?.result || [];
                for (const update of updates) {
                    this.lastUpdateId = update.update_id;
                    await this.processSingleUpdate(update);
                }
            } catch (error) {
                if (!error.message.includes('timeout')) {
                    console.error('⚠️ [TelegramService] Polling error:', error.message);
                }
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        }
    }

    startPolling() {
        if (!this.isPolling) {
            this.pollUpdates().catch((err) => console.error('Telegram polling error:', err));
        }
    }

    stopPolling() {
        this.isPolling = false;
    }

    getStatus() {
        return {
            botTokenConfigured: this.isConfigured(),
            botUsername: `@${this.botUsername}`,
            isPolling: this.isPolling,
            activeChatCount: this.activeChatIds.size
        };
    }
}

module.exports = new TelegramService();
