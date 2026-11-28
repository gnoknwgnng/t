// ---------------------------------------------------------------------------
// Dry run: picks real stories, writes drafts and prints them. Nothing is
// published to LinkedIn and nothing is saved.
//
//   node scripts/dry-run.js              3 drafts, console only
//   node scripts/dry-run.js --count 5    5 drafts on 5 different stories
//   node scripts/dry-run.js --category tech
//   node scripts/dry-run.js --telegram <chat id>   also send them to Telegram
//   node scripts/dry-run.js --json       print the full structured objects
// ---------------------------------------------------------------------------
process.env.POSTCRAFT_DRY_RUN = '1';
process.env.VERCEL = process.env.VERCEL || '1'; // never start the scheduler or Telegram polling
require('dotenv').config({ quiet: true });

const LinkedInPostGenerator = require('../linkedinPostGenerator');
const contentSettings = require('../config/contentSettings');
const playbookService = require('../services/playbookService');
const storyScorer = require('../services/storyScorer');
const postWriter = require('../services/postWriter');
const newsService = require('../services/newsService');

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] || true);
}

(async () => {
    const count = Number(option('count', 3));
    const category = String(option('category', newsService.NICHE_CATEGORY));
    const chatId = option('telegram', '');
    const asJson = process.argv.includes('--json');

    const settings = contentSettings.get();
    const generator = new LinkedInPostGenerator();
    const playbook = await playbookService.getPlaybook();
    const topic = category === newsService.NICHE_CATEGORY ? settings.niche : `${category} news`;

    console.log(`DRY RUN - nothing will be published`);
    console.log(`The fact check is automatic and can miss things: read each draft against its article before approving.`);
    console.log(`Niche: ${topic}`);
    console.log(`Playbook: ${playbook.version} (length ${playbook.length_range.min}-${playbook.length_range.max}, hashtags ${playbook.hashtag_policy.min}-${playbook.hashtag_policy.max}, link default ${playbook.link_policy.default_mode})`);

    const picked = await storyScorer.pickStories(category, { generator, playbook, limit: count });
    console.log(`Stories considered: ${picked.considered}, passed the niche filter: ${picked.stories.length}`);
    if (!picked.stories.length) {
        console.log(`Nothing to post: ${picked.reason}`);
        return;
    }

    const structures = Object.keys(postWriter.STRUCTURES);
    const hooks = Object.keys(postWriter.HOOK_TYPES);
    const linkModes = playbookService.LINK_MODES;

    for (let index = 0; index < picked.stories.length; index += 1) {
        const story = picked.stories[index];
        const draft = await postWriter.writeDraft({
            generator,
            story,
            topic,
            structure: structures[index % structures.length],
            hookType: hooks[index % hooks.length],
            playbook
        });
        const linkMode = linkModes[index % linkModes.length];
        const text = postWriter.assemblePost(draft, linkMode);
        const score = draft.meta.score;

        console.log(`\n${'='.repeat(78)}`);
        console.log(`POST ${index + 1}  |  ${story.source}  |  ${Math.round(newsService.ageInHours(story))}h old`);
        console.log(`Story: ${story.title}`);
        console.log(`Story score: relevance ${story.scores.relevance}, so-what ${story.scores.soWhat}, total ${story.scores.total}`);
        console.log(`Structure: ${draft.meta.structure}  |  Hook: ${draft.meta.hookType}  |  Link mode: ${linkMode}  |  ${text.length} chars  |  attempts: ${draft.meta.attempts}`);
        console.log(`Quality: ${score.overall}/10 ${score.passed ? 'PASS' : 'FAIL'} (hook ${score.hook}, specific ${score.specificity}, opinion ${score.opinion}, original ${score.originality}, facts ${score.factsOk ? 'ok' : 'INVENTED'})`);
        if (score.factProblems && score.factProblems.length) {
            console.log(`Fact check: ${score.factProblems.join(' | ')}`);
        }
        if (score.bannedHits.length || score.issues.length) {
            console.log(`Flags: ${[...score.bannedHits, ...score.issues].join(' | ')}`);
        }
        console.log(`${'-'.repeat(78)}\n${text}`);
        if (linkMode === 'first_comment') {
            console.log(`\n[first comment] ${draft.source_url}`);
        }
        if (asJson) {
            console.log(`\n${JSON.stringify(draft, null, 2)}`);
        }

        if (chatId) {
            const telegramService = require('../services/telegramService');
            await telegramService.sendMessage(chatId, `DRY RUN ${index + 1} (${score.overall}/10, ${draft.meta.structure})\n\n${text}`);
        }
    }
})().then(() => process.exit(0)).catch((error) => {
    console.error('Dry run failed:', error.message);
    process.exit(1);
});
