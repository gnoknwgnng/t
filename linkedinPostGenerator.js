const { Groq } = require('groq-sdk');
require('dotenv').config();
const newsService = require('./services/newsService');

class LinkedInPostGenerator {
    constructor() {
        this.groq = new Groq({
            apiKey: process.env.GROQ_API_KEY || ''
        });
        this.companyInfo = {};

        // Model priority list - best models first (openai/gpt-oss-120b as primary)
        this.models = [
            'openai/gpt-oss-120b',
            'meta-llama/llama-4-maverick-17b-128e-instruct',
            'llama-3.3-70b-versatile',
            'qwen/qwen3-32b',
            'deepseek-r1-distill-llama-70b',
            'openai/gpt-oss-20b',
            'moonshotai/kimi-k2-instruct',
            'llama-3.1-8b-instant',
            'groq/compound',
            'gemma2-9b-it',
            'groq/compound-mini'
        ];

        this.currentModelIndex = 0;
        this.modelFailures = new Map();
        this.platform = 'linkedin';
    }

    setPlatform(platform = 'linkedin') {
        const normalizedPlatform = String(platform || 'linkedin').toLowerCase();
        const supportedPlatforms = ['linkedin'];
        this.platform = supportedPlatforms.includes(normalizedPlatform) ? normalizedPlatform : 'linkedin';
    }

    getPlatformConfig() {
        const configs = {
            linkedin: {
                name: 'LinkedIn',
                audienceLabel: 'professional LinkedIn audience',
                systemStyle: 'professional, insightful, concise, and clean',
                hashtagGuidance: 'include relevant hashtags naturally',
                lengthGuidance: 'Keep each post within 300 words.',
                maxWords: 300
            }
        };

        return configs[this.platform] || configs.linkedin;
    }

    buildFallbackHashtags(companyName, services, industry) {
        const normalizedServices = Array.isArray(services)
            ? services
            : String(services || '').split(',').map((item) => item.trim()).filter(Boolean);

        const candidates = [
            companyName,
            industry,
            ...normalizedServices,
            'Business',
            'Innovation',
            'Growth',
            'LinkedIn'
        ];

        const hashtags = candidates
            .map((value) => String(value || '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim())
            .filter(Boolean)
            .map((value) => value.split(/\s+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(''))
            .filter(Boolean);

        return [...new Set(hashtags)].slice(0, 8);
    }

    async setCompanyInfo(companyName, website, services, industry, options = {}) {
        const skipAiHashtags = Boolean(options.skipAiHashtags);
        const hashtags = skipAiHashtags
            ? this.buildFallbackHashtags(companyName, services, industry)
            : await this.generateHashtags(companyName, services, industry);

        this.companyInfo = {
            name: companyName,
            website: website,
            services: services,
            industry: industry,
            hashtags: hashtags
        };
    }

    getDateRange(startDate, endDate) {
        const dates = [];
        const start = new Date(startDate);
        const end = new Date(endDate);

        const current = new Date(start);
        while (current <= end) {
            dates.push(new Date(current));
            current.setDate(current.getDate() + 1);
        }

        return dates;
    }

    getCurrentModel() {
        return this.models[this.currentModelIndex];
    }

    switchToNextModel() {
        const currentModel = this.getCurrentModel();
        this.modelFailures.set(currentModel, (this.modelFailures.get(currentModel) || 0) + 1);

        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;
        const nextModel = this.getCurrentModel();

        console.log(`Switching from ${currentModel} to ${nextModel}`);
        return nextModel;
    }

    async generateContentWithAI(prompt) {
        const platformConfig = this.getPlatformConfig();
        const systemPrompt = `You are a professional ${platformConfig.name} content creator. Generate ${platformConfig.systemStyle} posts for a ${platformConfig.audienceLabel}. Write strictly in clean plain text suitable for LinkedIn (DO NOT use any markdown formatting syntax such as **, __, *, or backticks). Do NOT use any emojis anywhere in the text, ${platformConfig.hashtagGuidance}, and follow this length rule: ${platformConfig.lengthGuidance}`;
        const currentModel = this.getCurrentModel();

        try {
            console.log(`Generating content with model ${currentModel}...`);

            const chatCompletion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                model: currentModel,
                temperature: 0.7,
                max_tokens: 600,
                top_p: 1,
                stream: false
            });

            let generatedContent = chatCompletion.choices[0]?.message?.content?.trim();

            if (generatedContent) {
                generatedContent = this.cleanLinkedInText(generatedContent);
                console.log(`Success with ${currentModel}:`, generatedContent.substring(0, 100) + '...');
                return generatedContent;
            }

        } catch (error) {
            console.error(`Error with ${currentModel}:`, error.message);

            if (error.status === 429 || error.message.includes('rate limit') || error.message.includes('quota')) {
                throw new Error(`RATE_LIMIT:${currentModel}`);
            } else if (error.status === 400 || error.message.includes('model')) {
                throw new Error(`MODEL_ERROR:${currentModel}`);
            } else {
                throw new Error(`UNKNOWN_ERROR:${currentModel}`);
            }
        }

        return null;
    }

    cleanLinkedInText(str) {
        if (!str) return '';
        return str
            // Remove markdown bold (**text** or __text__)
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/(^|[\s(])__([^_\n]+)__(?=$|[\s).,!?:;])/gm, '$1$2')
            // Remove markdown italic (*text* or _text_). Underscores only
            // count as markdown when they wrap a whole word or phrase, so
            // links such as https://site.com/a_b_c keep their underscores.
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, '$1$2')
            // Remove backticks
            .replace(/`([^`]+)`/g, '$1')
            // Strip emojis
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F650}-\u{1F67F}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}]/gu, '')
            .replace(/[^\S\r\n]+/g, ' ')
            .trim();
    }

    getModelStatus() {
        return {
            currentModel: this.getCurrentModel(),
            currentIndex: this.currentModelIndex,
            totalModels: this.models.length,
            failures: Object.fromEntries(this.modelFailures),
            availableModels: this.models
        };
    }

    resetModelFailures() {
        this.modelFailures.clear();
        this.currentModelIndex = 0;
        console.log('Reset model failures, starting with primary model again');
    }

    async generateHashtags(companyName, services, industry) {
        try {
            const platformConfig = this.getPlatformConfig();
            const servicesArray = Array.isArray(services) ? services : (services ? [services] : []);

            const prompt = `Generate 6-10 relevant hashtags for a ${platformConfig.name} post about:
Company: ${companyName}
Services: ${servicesArray.join(', ') || ''}
Industry: ${industry || 'Business'}

Requirements:
- Mix of industry-specific and general business hashtags
- Match ${platformConfig.name} style and discoverability
- Do NOT include any emojis or markdown symbols
- Return only hashtags separated by spaces, no explanations`;

            const response = await this.generateContentWithAI(prompt);

            if (response) {
                const hashtags = response.match(/#\w+/g) || [];
                return hashtags.map(tag => tag.replace('#', ''));
            }

            return ['Business', 'Innovation', 'Growth', 'Success', 'Leadership', 'Technology'];
        } catch (error) {
            console.error('Error generating hashtags:', error.message);
            return ['Business', 'Innovation', 'Growth', 'Success'];
        }
    }

    formatDate(date) {
        const options = {
            year: 'numeric',
            month: 'long',
            day: '2-digit',
            weekday: 'long'
        };
        const formatted = date.toLocaleDateString('en-US', options);
        const parts = formatted.split(', ');
        const weekday = parts[0];
        const monthDay = parts[1];
        const year = parts[2];

        return {
            full: `${monthDay}, ${year}`,
            weekday: weekday
        };
    }

    async generateNewsPost(date, category, article, options = {}) {
        const platformConfig = this.getPlatformConfig();
        const skipAi = Boolean(options.skipAi);

        if (!skipAi) {
            const aiContent = await this.generateContentWithAI(this.buildNewsPostPrompt(category, article));
            if (aiContent) {
                return this.ensureArticleLink(this.cleanLinkedInText(aiContent), article);
            }
        }

        // Fallback when no AI model is available: report the story plainly.
        const cleanHeadline = this.cleanLinkedInText(article.title);
        const cleanSummary = this.cleanLinkedInText(article.summary);
        const topicTag = this.toHashtag(category);
        const body = cleanSummary && cleanSummary !== cleanHeadline ? `\n\n${cleanSummary}` : '';

        return `${cleanHeadline}${body}

Read more: ${article.link}

${[topicTag, '#News'].filter(Boolean).join(' ')}`.trim();
    }

    toHashtag(value) {
        const cleaned = String(value || '')
            .replace(/[^a-zA-Z0-9 ]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join('');
        return cleaned ? `#${cleaned}` : '';
    }

    // The model sometimes drops or rewrites the link; the post must always
    // point at the real story.
    ensureArticleLink(post, article) {
        if (!article.link || post.includes(article.link)) {
            return post;
        }

        const lines = post.split('\n');
        const lastLine = lines[lines.length - 1] || '';
        const hashtagsOnly = /^(\s*#\w+)+\s*$/.test(lastLine);
        const linkLine = `Read more: ${article.link}`;

        if (hashtagsOnly) {
            lines.splice(lines.length - 1, 0, linkLine, '');
            return lines.join('\n');
        }
        return `${post}\n\n${linkLine}`;
    }

    // Who is posting, in the words the person gave us. Left out entirely when
    // nothing useful was provided, so the model does not invent a company.
    describePoster() {
        const info = this.companyInfo || {};
        const services = Array.isArray(info.services) ? info.services.filter(Boolean) : (info.services ? [info.services] : []);
        const industry = String(info.industry || '').trim();
        const lines = [];

        if (info.name) lines.push(`Company: ${info.name}`);
        if (industry && industry.toLowerCase() !== 'general') lines.push(`Industry: ${industry}`);
        if (services.length) lines.push(`What they do: ${services.slice(0, 6).join('; ')}`);

        return lines.join('\n');
    }

    buildNewsPostPrompt(category, article) {
        const poster = this.describePoster();
        const published = article.publishedAt
            ? new Date(article.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'recent';
        const audience = (this.companyInfo?.industry && String(this.companyInfo.industry).toLowerCase() !== 'general')
            ? `people who work in ${this.companyInfo.industry}`
            : `people who follow ${category} news`;

        return `Write a LinkedIn post about the news story below.

THE STORY
Headline: ${article.title}
Summary: ${article.summary}
Source: ${article.source || 'news report'}
Published: ${published}
Topic: ${category}
Link: ${article.link}
${poster ? `
WHO IS POSTING
${poster}
` : ''}
HOW TO WRITE IT
- First line: say what happened, specifically and plainly. Do not open with phrases like "In today's fast-paced world", "Exciting news", "Big news" or a rhetorical question.
- Then two or three short paragraphs: what happened, and why it matters to ${audience}.
- Use only facts that are in the headline and summary above. Do not invent numbers, quotes, names or details. If the summary is thin, keep the post short rather than padding it.
${poster ? '- Add one sentence of honest perspective from the point of view of the company above. Do not turn the post into an advertisement and do not suggest the company was involved in the story.\n' : ''}- End the body with one genuine question that invites people to comment.
- After the body, on its own line, write exactly: Read more: ${article.link}
- Last line: 3 to 5 specific hashtags for this story. Avoid filler hashtags such as #Innovation, #BusinessGrowth or #Success.
- Length: 90 to 170 words before the link line.
- Separate paragraphs with a blank line. Plain text only: no markdown, no emojis, no bullet symbols, no headings.
- Sound like a thoughtful person sharing something they read, not a press release.

Return only the post text.`;
    }

    async generateCalendar(startDate, endDate, countryCodeOrOptions = 'US', options = {}) {
        let opts = {};
        if (typeof countryCodeOrOptions === 'object' && countryCodeOrOptions !== null) {
            opts = countryCodeOrOptions;
        } else {
            opts = options || {};
        }

        const mode = opts.mode === 'rotation' ? 'rotation' : 'block';
        // Built-in categories (tech, science, dental) or any custom topic.
        let categories = (Array.isArray(opts.categories) ? opts.categories : [])
            .map((c) => newsService.normalizeCategory(c))
            .filter(Boolean)
            .slice(0, 14);
        if (categories.length === 0) {
            categories = ['tech', 'science', 'dental'];
        }

        const dates = this.getDateRange(startDate, endDate);
        const calendar = [];
        const usedUrls = new Set();
        let currentModel = this.getCurrentModel();

        console.log(`Starting news calendar generation (${dates.length} posts, Mode: ${mode}, Categories: [${categories.join(', ')}]) using model: ${currentModel}`);

        for (let i = 0; i < dates.length; i++) {
            const date = dates[i];
            const category = (mode === 'block') ? categories[0] : categories[i % categories.length];

            const article = await newsService.getArticleForCategory(category, usedUrls);
            if (!article) {
                // No canned stand-in: better to say so than to write a post
                // about news that did not happen.
                throw new Error(`No recent news could be loaded for "${category}". Try again in a few minutes or pick another topic.`);
            }
            let post = null;

            try {
                post = await this.generateNewsPost(date, category, article, opts);
                calendar.push({
                    date: date.toISOString().split('T')[0],
                    type: 'news',
                    category: category,
                    articleTitle: article.title,
                    articleLink: article.link,
                    articleSummary: article.summary,
                    articleSource: article.source || '',
                    articlePublishedAt: article.publishedAt || null,
                    post: post,
                    model: currentModel
                });
            } catch (error) {
                if (error.message.includes('RATE_LIMIT') || error.message.includes('MODEL_ERROR') || error.message.includes('UNKNOWN_ERROR')) {
                    console.log(`Model ${currentModel} failed, switching to next model for remaining posts`);
                    this.switchToNextModel();
                    currentModel = this.getCurrentModel();

                    try {
                        post = await this.generateNewsPost(date, category, article, opts);
                        calendar.push({
                            date: date.toISOString().split('T')[0],
                            type: 'news',
                            category: category,
                            articleTitle: article.title,
                            articleLink: article.link,
                            articleSummary: article.summary,
                            post: post,
                            model: currentModel
                        });
                    } catch (retryError) {
                        console.log(`New model ${currentModel} also failed, using fallback template for this post`);
                        post = await this.generateNewsPost(date, category, article, { ...opts, skipAi: true });
                        calendar.push({
                            date: date.toISOString().split('T')[0],
                            type: 'news',
                            category: category,
                            articleTitle: article.title,
                            articleLink: article.link,
                            articleSummary: article.summary,
                            post: post,
                            model: 'template-fallback'
                        });
                    }
                } else {
                    throw error;
                }
            }
        }

        console.log(`News calendar generation completed. Generated ${calendar.length} posts.`);
        return calendar;
    }

    exportToJSON(calendar) {
        return JSON.stringify(calendar, null, 2);
    }

    exportToText(calendar) {
        return (calendar || []).map(item => {
            const cat = String(item.category || 'general').toUpperCase();
            const headline = item.articleTitle || 'N/A';
            const postContent = item.post || '';
            return `${item.date} [Category: ${cat}]\nHeadline: ${headline}\n${'-'.repeat(50)}\n${postContent}\n\n`;
        }).join('');
    }
}

module.exports = LinkedInPostGenerator;
