// ---------------------------------------------------------------------------
// Draft flow: what happens between "a scheduled post is due" and "it is on
// LinkedIn".
//
//   prepareDrafts()  picks niche stories, writes three scored drafts and
//                    decides the link placement for this post
//   approveDraft()   publishes the draft the user approved - or, in dry-run
//                    mode, only records what would have been published
//
// Nothing in here sends Telegram messages (telegramService does that), and
// nothing publishes without an explicit approval for that exact draft.
// ---------------------------------------------------------------------------
const LinkedInPostGenerator = require('../linkedinPostGenerator');
const contentSettings = require('../config/contentSettings');
const newsService = require('./newsService');
const playbookService = require('./playbookService');
const storyScorer = require('./storyScorer');
const postWriter = require('./postWriter');
const platformPublishers = require('./platformPublishers');

// What this user has already posted or been offered, newest first.
function historyFor(state, userId, excludeItemId = '') {
    const items = (state.queue || [])
        .filter((item) => item.userId === userId && item.id !== excludeItemId)
        .sort((a, b) => new Date(b.scheduledFor) - new Date(a.scheduledFor));
    const published = items.filter((item) => item.status === 'published');

    const usedLinks = new Set();
    items.forEach((item) => {
        if (item.metadata?.articleLink) usedLinks.add(item.metadata.articleLink);
        (item.metadata?.telegramOptions || []).forEach((option) => { if (option?.link) usedLinks.add(option.link); });
        (item.metadata?.drafts || []).forEach((draft) => { if (draft?.source_url) usedLinks.add(draft.source_url); });
    });

    return {
        published,
        usedLinks,
        recentStructures: published.map((item) => item.metadata?.structure).filter(Boolean),
        linkHistory: published.map((item) => item.metadata?.linkMode).filter(Boolean)
    };
}

function topicFor(category) {
    const settings = contentSettings.get();
    return category === newsService.NICHE_CATEGORY ? settings.niche : `${category} news`;
}

// Returns { drafts, linkMode, topic, playbookVersion, flags, reason }.
// `drafts` is empty (with a reason) when no story is good enough: in that
// case nothing should be posted for this slot.
//   options.myAngle   - the user's own line, woven into every draft verbatim
//   options.stories   - reuse these stories instead of picking new ones
//   options.generator - injected in tests
async function prepareDrafts({ queueItem, state, options = {} }) {
    const generator = options.generator || new LinkedInPostGenerator();
    const category = newsService.normalizeCategory(queueItem.metadata?.category) || newsService.NICHE_CATEGORY;
    const topic = topicFor(category);
    const playbook = await playbookService.getPlaybook();
    const history = historyFor(state, queueItem.userId, queueItem.id);
    const learning = playbookService.applyAccountLearning(playbook, history.published);

    let stories = options.stories || [];
    let reason = '';
    if (!stories.length) {
        const picked = await storyScorer.pickStories(category, {
            generator,
            playbook,
            excludeUrls: history.usedLinks,
            limit: 3
        });
        stories = picked.stories;
        reason = picked.reason;
    }

    if (!stories.length) {
        return { drafts: [], reason: reason || 'No suitable story today.', topic, playbookVersion: playbook.version, flags: learning.flags };
    }

    const drafts = await postWriter.writeOptions({
        generator,
        stories,
        topic,
        playbook,
        recentStructures: history.recentStructures,
        preferredStructure: learning.overrides.preferredStructure,
        myAngle: options.myAngle || ''
    });

    if (!drafts.length) {
        return { drafts: [], reason: 'The drafts could not be written (the AI models did not respond). Use Publish Now to try again.', topic, playbookVersion: playbook.version, flags: learning.flags };
    }

    const passing = selectPassingDrafts(drafts);
    if (!passing.length) {
        const bar = contentSettings.get().qualityMinScore;
        return {
            drafts: [],
            reason: `None of the ${drafts.length} drafts reached the quality bar (${bar}/10, no invented facts), so nothing was offered. Use Publish Now to try again, or write the post yourself with Edit.`,
            topic,
            playbookVersion: playbook.version,
            flags: learning.flags
        };
    }

    // One link placement per post, so results can be compared between posts.
    const linkMode = options.linkMode || postWriter.chooseLinkMode(history.linkHistory, playbook, learning.overrides.linkMode);

    return {
        drafts: passing.map((draft) => ({ ...draft, final_text: postWriter.assemblePost(draft, linkMode) })),
        linkMode,
        topic,
        // Kept so a "my angle" redraft reuses the same stories.
        stories: stories.map(({ title, summary, detail, link, source, publishedAt, angle, scores }) => ({ title, summary, detail, link, source, publishedAt, angle, scores })),
        playbookVersion: playbook.version,
        flags: learning.flags,
        reason: ''
    };
}

// Only drafts that cleared the quality bar may be offered. A draft that
// failed (low score, invented facts, banned phrases, format problems) is
// dropped here, so it can never be approved from Telegram.
function selectPassingDrafts(drafts) {
    return (drafts || []).filter((draft) => draft?.meta?.score?.passed === true);
}

// Everything recorded about a post once it has been approved. These fields
// are what the performance view groups by (see supabase-migration-content.sql).
function publishedMetadata(queueItem, draft, linkMode, choiceIndex) {
    const { final_text: finalText, meta, ...structured } = draft;
    const previous = { ...(queueItem.metadata || {}) };
    delete previous.drafts;
    delete previous.stories;

    return {
        ...previous,
        chosenOption: choiceIndex + 1,
        contentStatus: 'generated',
        confirmedAt: new Date().toISOString(),
        articleTitle: (queueItem.metadata?.stories || []).find((story) => story.link === draft.source_url)?.title || previous.articleTitle || '',
        articleLink: draft.source_url,
        structure: meta.structure,
        hookType: meta.hookType,
        topic: meta.topic,
        linkMode,
        hashtagCount: draft.hashtags.length,
        qualityScore: meta.score.overall,
        qualityDetail: { hook: meta.score.hook, specificity: meta.score.specificity, opinion: meta.score.opinion, originality: meta.score.originality },
        // Filled in by hand from LinkedIn analytics (Publishing Hub).
        metrics: previous.metrics || { impressions: null, reactions: null, comments: null, saves: null, reposts: null },
        // The contract for Video Studio.
        structured
    };
}

// Publishes one approved draft. Returns { patch, published, dryRun, note }.
// `patch` is what the caller saves on the queue item.
async function approveDraft({ queueItem, account, choiceIndex }) {
    const settings = contentSettings.get();
    const draft = (queueItem.metadata?.drafts || [])[choiceIndex];
    if (!draft) {
        throw new Error('That draft no longer exists.');
    }

    const linkMode = queueItem.metadata?.linkMode || 'none';
    const metadata = publishedMetadata(queueItem, draft, linkMode, choiceIndex);
    const patch = { content: draft.final_text, metadata, updatedAt: new Date().toISOString() };

    if (settings.dryRun) {
        patch.status = 'failed';
        patch.error = 'Dry run: this post was approved but NOT published.';
        patch.metadata = { ...metadata, dryRun: true };
        return { patch, published: false, dryRun: true, note: 'Dry run: nothing was sent to LinkedIn.' };
    }

    const result = await platformPublishers.publishToPlatform('linkedin', account, { content: draft.final_text });
    patch.status = 'published';
    patch.publishedAt = new Date().toISOString();
    patch.providerId = result.providerId || null;
    patch.providerResponse = result.providerResponse || null;
    patch.error = null;
    patch.errorStatus = null;

    let note = '';
    if (linkMode === 'first_comment' && draft.source_url) {
        try {
            await platformPublishers.commentOnLinkedInPost(account, result.providerId, draft.source_url);
            patch.metadata.linkComment = 'posted';
        } catch (error) {
            // The post itself is live; only the comment failed.
            patch.metadata.linkComment = 'failed';
            patch.metadata.linkCommentError = String(error.response?.data?.message || error.message).slice(0, 200);
            note = `The link could not be added as the first comment automatically. Add it yourself: ${draft.source_url}`;
        }
    }

    return { patch, published: true, dryRun: false, note };
}

module.exports = { prepareDrafts, approveDraft, historyFor, topicFor, publishedMetadata, selectPassingDrafts };
