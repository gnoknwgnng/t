require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cookie = require('cookie');
const LinkedInPostGenerator = require('./linkedinPostGenerator');
const { readState, writeState, createId, upsertProfile, getProfile, createTelegramLinkCode, unlinkTelegramChat } = require('./services/publishingStore');
const { createScheduleAndQueue, publishQueueItem, startScheduler } = require('./services/schedulerService');
const telegramService = require('./services/telegramService');
const {
    getLinkedInOAuthConfig,
    isLinkedInOAuthConfigured,
    createOAuthStateToken,
    verifyOAuthStateToken,
    fetchLinkedInUserInfo,
    upsertLinkedInOAuthAccount,
    createSessionToken,
    verifySessionToken,
    SESSION_MAX_AGE_MS
} = require('./services/oauthService');

const app = express();
const port = process.env.PORT || 3000;
const SESSION_COOKIE_NAME = 'postcraft_session';
const isProduction = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// "Sign in with LinkedIn" IS the login here — there's no separate email/
// password step. What makes this safe for multiple people to use at once:
//
// 1. /auth/linkedin/start generates a signed, single-use state token before
//    sending the browser to LinkedIn (see oauthService.createOAuthStateToken).
// 2. LinkedIn authenticates the person and sends them back with that same
//    state. /auth/linkedin/callback verifies the signature (proves the
//    request really is a reply to the one we sent, not a forged one) and
//    exchanges the code for a LinkedIn profile.
// 3. Only THEN do we mint our own session token — signed with a server-only
//    secret — and set it as an httpOnly cookie scoped to that one browser.
//
// A person in a different Chrome profile / different browser / incognito
// window has no cookie, so requireAuth below rejects them and the frontend
// sends them to sign in with their own LinkedIn account. Nothing here is
// ever trusted just because the client claims it — every request re-verifies
// the cookie's signature server-side.
// ---------------------------------------------------------------------------
function setSessionCookie(res, token) {
    res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
        path: '/'
    }));
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 0,
        path: '/'
    }));
}

function getSessionFromRequest(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) {
        return null;
    }
    const config = getLinkedInOAuthConfig();
    return verifySessionToken(token, config);
}

function requireAuth(req, res, next) {
    const session = getSessionFromRequest(req);
    if (!session) {
        return res.status(401).json({ success: false, error: 'Sign in required.' });
    }
    req.user = { id: session.userId, email: session.email, displayName: session.displayName };
    req.userContext = { userId: session.userId };
    next();
}

function filterLinkedInState(state) {
    const linkedInAccounts = (state.accounts || []).filter((item) => item.platform === 'linkedin');
    const linkedInAccountIds = new Set(linkedInAccounts.map((item) => item.id));
    const linkedInSchedules = (state.schedules || []).filter((item) =>
        item.platform === 'linkedin' && linkedInAccountIds.has(item.accountId)
    );
    const linkedInScheduleIds = new Set(linkedInSchedules.map((item) => item.id));
    const linkedInQueue = (state.queue || []).filter((item) =>
        item.platform === 'linkedin' &&
        linkedInAccountIds.has(item.accountId) &&
        linkedInScheduleIds.has(item.scheduleId)
    );

    return {
        accounts: linkedInAccounts,
        schedules: linkedInSchedules,
        queue: linkedInQueue
    };
}

const path = require('path');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize generator
const generator = new LinkedInPostGenerator();

// Routes
app.get('/api', (req, res) => {
    res.json({
        message: 'LinkedIn Post Generator API',
        endpoints: {
            '/generate': 'POST - Generate LinkedIn post calendar with RSS news categories',
            '/publishing/accounts': 'GET/POST - Manage connected publishing accounts',
            '/publishing/schedules': 'GET/POST - Manage weekly publishing schedules',
            '/publishing/queue': 'GET - View scheduled and published queue items',
            '/publishing/providers': 'GET - View publishing provider configuration status',
            '/auth/linkedin/start': 'GET - Start LinkedIn OAuth login',
            '/auth/linkedin/callback': 'GET - Complete LinkedIn OAuth login',
            '/telegram/status': 'GET - View Telegram verification bot status',
            '/telegram/send-verification': 'POST - Send top 3 news options to Telegram bot'
        }
    });
});

// Every /publishing/* route needs a verified signed-in user EXCEPT /providers,
// which just reports whether LinkedIn OAuth is configured on this server (no
// user data involved, and the sign-in page needs to be able to check it
// before the person has signed in).
app.use('/publishing', (req, res, next) => {
    if (req.path === '/providers') {
        return next();
    }
    return requireAuth(req, res, next);
});

// Clear the signed-in user's own session data (wipes just their bucket)
app.post('/session/clear', requireAuth, async (req, res) => {
    try {
        await writeState({ accounts: [], schedules: [], queue: [] }, { ...req.userContext, localOnly: true });
        res.json({ success: true, message: 'Your session data was cleared.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/publishing/overview', async (req, res) => {
    try {
        const state = await readState(req.userContext);
        res.json({ success: true, ...filterLinkedInState(state) });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load publishing overview' });
    }
});

app.get('/publishing/accounts', async (req, res) => {
    try {
        const state = await readState(req.userContext);
        res.json({ success: true, accounts: filterLinkedInState(state).accounts });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load accounts' });
    }
});

app.get('/publishing/providers', (req, res) => {
    const linkedInConfig = getLinkedInOAuthConfig();
    res.json({
        success: true,
        providers: {
            linkedin: {
                oauthConfigured: isLinkedInOAuthConfigured(),
                redirectUri: linkedInConfig.redirectUri,
                scope: linkedInConfig.scope
            }
        }
    });
});

app.post('/publishing/accounts', async (req, res) => {
    try {
        const {
            platform,
            displayName,
            accessToken,
            authorUrn
        } = req.body;

        if (!platform || !displayName || !accessToken) {
            return res.status(400).json({ success: false, error: 'platform, displayName, and accessToken are required' });
        }

        if (platform !== 'linkedin') {
            return res.status(400).json({ success: false, error: 'Only linkedin accounts are supported.' });
        }

        const state = await readState(req.userContext);
        const account = {
            id: createId('account'),
            platform,
            displayName,
            accessToken,
            authorUrn: authorUrn || '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'connected'
        };

        state.accounts.push(account);
        await writeState(state, req.userContext);
        res.json({ success: true, account });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to save account', details: error.message });
    }
});

app.get('/auth/linkedin/start', (req, res) => {
    try {
        if (!isLinkedInOAuthConfigured()) {
            return res.status(500).send('LinkedIn OAuth is not configured on this server.');
        }

        const config = getLinkedInOAuthConfig();
        const returnTo = String(req.query.next || '').trim() === 'publisher' ? '/publisher.html' : '/auth.html';

        // Note: no app userId goes into the state here — LinkedIn OAuth IS
        // the sign-in step now, so there's no user yet until the callback
        // below succeeds and mints a session.
        const state = createOAuthStateToken(config, { returnTo });

        const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', config.clientId);
        authUrl.searchParams.set('redirect_uri', config.redirectUri);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('scope', config.scope);

        // force=1 makes LinkedIn show the account picker again instead of
        // silently reusing whatever LinkedIn session is cached in this
        // browser — needed to let someone switch which LinkedIn account they
        // sign in with, on the same machine.
        if (req.query.force === '1') {
            authUrl.searchParams.set('prompt', 'login');
        }

        res.redirect(authUrl.toString());
    } catch (error) {
        res.status(500).send(`Failed to start LinkedIn OAuth: ${error.message}`);
    }
});

app.get('/auth/linkedin/callback', async (req, res) => {
    const {
        code,
        state,
        error,
        error_description: errorDescription
    } = req.query;

    const config = getLinkedInOAuthConfig();
    const verifiedState = verifyOAuthStateToken(state, config);
    const returnTo = verifiedState?.returnTo && String(verifiedState.returnTo).startsWith('/')
        ? verifiedState.returnTo
        : '/auth.html';

    if (error) {
        return res.redirect(`${returnTo}?linkedin=${encodeURIComponent(error)}&message=${encodeURIComponent(errorDescription || 'LinkedIn authorization failed')}`);
    }

    // verifiedState is null if the signature doesn't match (forged/tampered
    // state) or it's older than 10 minutes — either way, reject it.
    if (!code || !verifiedState) {
        return res.redirect(`${returnTo}?linkedin=invalid_state`);
    }

    try {
        const tokenParams = new URLSearchParams();
        tokenParams.set('grant_type', 'authorization_code');
        tokenParams.set('code', String(code));
        tokenParams.set('redirect_uri', config.redirectUri);
        tokenParams.set('client_id', config.clientId);
        tokenParams.set('client_secret', config.clientSecret);

        const tokenResponse = await axios.post(
            'https://www.linkedin.com/oauth/v2/accessToken',
            tokenParams.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const accessToken = tokenResponse.data?.access_token;
        const expiresIn = tokenResponse.data?.expires_in;

        if (!accessToken) {
            throw new Error('LinkedIn token exchange did not return an access token.');
        }

        const profile = await fetchLinkedInUserInfo(accessToken);
        const memberId = profile.sub || '';

        if (!memberId) {
            throw new Error('LinkedIn did not return a member ID for this account.');
        }

        // The LinkedIn member ID IS this person's app identity — it's stable,
        // unique per LinkedIn account, and only reachable by actually
        // completing LinkedIn's own login. Two different LinkedIn accounts
        // always get two different userIds, so their accounts/schedules/
        // queues stay in completely separate rows.
        const account = await upsertLinkedInOAuthAccount({
            accessToken,
            expiresIn,
            profile,
            userContext: { userId: memberId }
        });

        // Registry of every person who has signed in, independent of
        // whatever publishing accounts they have connected. This is what
        // lets the Telegram bot (and anything else) look someone up by
        // their app identity rather than reaching into `accounts`.
        await upsertProfile({
            id: memberId,
            email: account.email || '',
            displayName: account.displayName || 'LinkedIn User',
            profilePicture: account.profilePicture || ''
        });

        const sessionToken = createSessionToken(config, {
            userId: memberId,
            email: account.email || '',
            displayName: account.displayName || 'LinkedIn User',
            linkedinMemberId: memberId
        });
        setSessionCookie(res, sessionToken);

        res.redirect(`${returnTo}?linkedin=connected`);
    } catch (callbackError) {
        console.error('[LinkedIn OAuth Callback Error]:', callbackError.response?.data || callbackError.message);
        const errorMessage = callbackError.response?.data?.error_description || callbackError.response?.data?.error || callbackError.message;
        res.redirect(`${returnTo}?linkedin=failed&message=${encodeURIComponent(errorMessage)}`);
    }
});

// Lets the frontend ask "am I signed in" without needing to store anything
// itself — the cookie is the only source of truth, verified fresh every time.
app.get('/auth/session', (req, res) => {
    const session = getSessionFromRequest(req);
    if (!session) {
        return res.status(401).json({ success: false, error: 'Not signed in.' });
    }
    res.json({
        success: true,
        user: {
            id: session.userId,
            email: session.email,
            displayName: session.displayName
        }
    });
});

app.post('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ success: true });
});

app.get('/publishing/schedules', async (req, res) => {
    try {
        const state = await readState(req.userContext);
        res.json({ success: true, schedules: filterLinkedInState(state).schedules });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load schedules' });
    }
});

app.post('/publishing/schedules', async (req, res) => {
    try {
        const {
            platform,
            accountId,
            postsPerWeek,
            companyName,
            website,
            industry,
            services,
            countryCode,
            preferredHour,
            startDate,
            endDate
        } = req.body;

        if (!platform || !accountId || !postsPerWeek) {
            return res.status(400).json({ success: false, error: 'platform, accountId, and postsPerWeek are required' });
        }

        if (platform !== 'linkedin') {
            return res.status(400).json({ success: false, error: 'Only linkedin schedules are supported.' });
        }

        if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
            return res.status(400).json({ success: false, error: 'endDate must be on or after startDate' });
        }

        const normalizedServices = Array.isArray(services)
            ? services
            : String(services || '').split('\n').map((item) => item.trim()).filter(Boolean);

        const result = await createScheduleAndQueue({
            platform,
            accountId,
            postsPerWeek: Number(postsPerWeek),
            companyName,
            website,
            industry,
            services: normalizedServices,
            countryCode,
            preferredHour: Number(preferredHour || 10),
            startDate: startDate ? new Date(startDate) : new Date(),
            endDate: endDate ? new Date(endDate) : undefined
        }, req.userContext);

        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to create schedule', details: error.message });
    }
});

app.get('/publishing/queue', async (req, res) => {
    try {
        const state = await readState(req.userContext);
        res.json({ success: true, queue: filterLinkedInState(state).queue });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load queue' });
    }
});

app.post('/publishing/queue/:id/publish', async (req, res) => {
    try {
        const state = await readState(req.userContext);
        const existingItem = state.queue.find((item) => item.id === req.params.id);
        if (!existingItem) {
            return res.status(404).json({ success: false, error: 'Queue item not found' });
        }

        if (existingItem.platform !== 'linkedin') {
            return res.status(400).json({ success: false, error: 'Only linkedin queue items can be published.' });
        }

        const item = await publishQueueItem(req.params.id, req.userContext);
        res.json({ success: item.status === 'published', item });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to publish queue item', details: error.message });
    }
});

app.patch('/publishing/queue/:id', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'content is required' });
        }

        const state = await readState(req.userContext);
        const item = state.queue.find((q) => q.id === req.params.id);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Queue item not found' });
        }

        item.content = content.trim();
        item.updatedAt = new Date().toISOString();
        if (item.metadata) {
            item.metadata.contentStatus = 'manually_edited';
        }

        await writeState(state, req.userContext);
        res.json({ success: true, item });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update queue item', details: error.message });
    }
});


app.get('/model-status', (req, res) => {
    try {
        const status = generator.getModelStatus();
        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get model status' });
    }
});

// Reset model failures
app.post('/reset-models', (req, res) => {
    try {
        generator.resetModelFailures();
        res.json({
            success: true,
            message: 'Model failures reset successfully',
            currentModel: generator.getCurrentModel()
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reset models' });
    }
});

const improvePostHandler = async (req, res) => {
    try {
        const {
            currentPost,
            userRequest,
            postType,
            holiday,
            postTypeCategory,
            companyInfo
        } = req.body;

        // Validate required fields
        if (!currentPost || !userRequest) {
            return res.status(400).json({
                error: 'currentPost and userRequest are required'
            });
        }

        generator.setPlatform('linkedin');
        const platformName = generator.getPlatformConfig().name;

        // Create improvement prompt
        const improvementPrompt = `You are a professional ${platformName} content expert. A user wants to improve their ${platformName} post.

Current Post:
"${currentPost}"

Post Context:
- Type: ${postType} ${holiday ? `(Holiday: ${holiday})` : `(Category: ${postTypeCategory})`}
- Company: ${companyInfo?.name || 'Unknown'}
- Industry: ${companyInfo?.industry || 'Business'}

User Request: "${userRequest}"

Please provide:
1. A brief explanation of what you'll improve (2-3 sentences)
2. An improved version of the post that addresses their request

Keep the improved post professional, engaging, and suitable for ${platformName}. Maintain the original structure and key information while implementing the requested changes.

Format your response as:
EXPLANATION: [Your explanation here]
IMPROVED_POST: [The improved post here]`;

        // Generate improvement using AI
        const aiResponse = await generator.generateContentWithAI(improvementPrompt);

        if (aiResponse) {
            // Parse the AI response
            const explanationMatch = aiResponse.match(/EXPLANATION:\s*(.*?)(?=IMPROVED_POST:|$)/s);
            const improvedPostMatch = aiResponse.match(/IMPROVED_POST:\s*(.*)/s);

            const explanation = explanationMatch ? explanationMatch[1].trim() : "I've improved your post based on your request.";
            const improvedPost = improvedPostMatch ? improvedPostMatch[1].trim() : aiResponse;

            res.json({
                success: true,
                explanation: explanation,
                improvedPost: improvedPost,
                originalPost: currentPost
            });
        } else {
            throw new Error('AI service unavailable');
        }
    } catch (error) {
        console.error('Error improving post:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to improve post',
            details: error.message
        });
    }
};

// Improve existing post with AI
app.post('/improve-post', improvePostHandler);

const generateCalendarHandler = async (req, res) => {
    try {
        const {
            startDate,
            endDate,
            mode = 'rotation',
            categories = ['tech', 'science', 'dental'],
            companyName,
            website,
            industry,
            services,
            format = 'json'
        } = req.body;

        // Validate required fields
        if (!startDate || !endDate) {
            return res.status(400).json({
                error: 'startDate and endDate are required'
            });
        }

        // Process services - convert string to array if needed
        let processedServices = services;
        if (typeof services === 'string') {
            processedServices = services.split('\n').filter(s => s.trim()).map(s => s.trim());
        } else if (!Array.isArray(services)) {
            processedServices = [];
        }

        const selectedPlatform = 'linkedin';
        generator.setPlatform(selectedPlatform);

        // Set company information
        await generator.setCompanyInfo(companyName, website, processedServices, industry);

        // Process category selection mode
        const normalizedMode = mode === 'rotation' ? 'rotation' : 'block';
        const parsedCategories = Array.isArray(categories) ? categories : [categories];

        // Generate calendar
        const calendar = await generator.generateCalendar(startDate, endDate, {
            mode: normalizedMode,
            categories: parsedCategories
        });

        // Return in requested format
        if (format === 'text') {
            res.set('Content-Type', 'text/plain');
            res.send(generator.exportToText(calendar));
        } else {
            res.json({
                success: true,
                platform: selectedPlatform,
                dateRange: { startDate, endDate },
                mode: normalizedMode,
                categories: parsedCategories,
                totalPosts: calendar.length,
                calendar: calendar
            });
        }
    } catch (error) {
        console.error('Error generating calendar:', error);
        res.status(500).json({
            error: 'Failed to generate calendar',
            details: error.message
        });
    }
};

// Generate calendar endpoints
app.post('/generate', generateCalendarHandler);

// Telegram bot endpoints
app.get('/telegram/status', requireAuth, async (req, res) => {
    try {
        if (isVercel) {
            const siteUrl = getLinkedInOAuthConfig(req).siteUrl;
            await telegramService.setupWebhook(siteUrl);
        }
        const profile = await getProfile(req.userContext.userId);
        res.json({
            success: true,
            ...telegramService.getStatus(),
            linked: Boolean(profile?.telegramChatId)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load Telegram status', details: error.message });
    }
});

// Generates a one-time https://t.me/<bot>?start=<code> link tied to the
// signed-in user. Opening it in Telegram is what proves a given Telegram
// chat belongs to this person — see linkTelegramChatByCode in
// publishingStore.js and the /start handler in telegramService.js.
app.post('/telegram/link', requireAuth, async (req, res) => {
    try {
        if (!telegramService.isConfigured()) {
            return res.status(500).json({ success: false, error: 'Telegram bot is not configured on this server.' });
        }

        const { code } = await createTelegramLinkCode(req.userContext.userId);
        res.json({
            success: true,
            linkUrl: telegramService.getDeepLink(code),
            expiresInMinutes: 15
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to create Telegram link', details: error.message });
    }
});

app.post('/telegram/unlink', requireAuth, async (req, res) => {
    try {
        await unlinkTelegramChat(req.userContext.userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to unlink Telegram', details: error.message });
    }
});

app.post('/telegram/send-verification', async (req, res) => {
    try {
        const { chatId, companyName, website, services, industry } = req.body || {};
        const result = await telegramService.sendTop3Verification(chatId, { companyName, website, services, industry });
        res.json(result);
    } catch (error) {
        console.error('Error sending Telegram verification:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send Telegram verification',
            details: error.message
        });
    }
});

// Vercel Cron Endpoint: Triggered automatically by Vercel Cron to process due queue items
app.get('/api/cron/publish', async (req, res) => {
    try {
        const { publishDueQueueItems } = require('./services/schedulerService');
        const result = await publishDueQueueItems({}, { scope: 'all' });
        res.json({ success: true, timestamp: new Date().toISOString(), ...result });
    } catch (error) {
        console.error('Cron publish error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Telegram Webhook Endpoint: Triggered by Telegram when running serverless on Vercel
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        await telegramService.handleWebhookUpdate(req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('Telegram webhook error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Detect Vercel environment vs Local execution
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

if (!isVercel) {
    app.listen(port, () => {
        console.log(`LinkedIn Post Generator API running on port ${port}`);
        console.log(`Visit http://localhost:${port} for API documentation`);
    });

    startScheduler();
    telegramService.startPolling();
}

module.exports = app;
