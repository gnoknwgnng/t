const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

// POSTCRAFT_DATA_DIR lets tests keep their records away from real local data.
const dataDir = process.env.POSTCRAFT_DATA_DIR || path.join(__dirname, '..', 'data');
const statePath = path.join(dataDir, 'publishing-state.json');

const defaultState = {
    accounts: [],
    schedules: [],
    queue: []
};

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ''
).trim();
const isSupabaseEnabled = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const SUPABASE_REST_BASE = isSupabaseEnabled ? `${SUPABASE_URL}/rest/v1` : '';

function cloneDefaultState() {
    return JSON.parse(JSON.stringify(defaultState));
}

function createUnauthorizedError(message = 'Authenticated user context is required.') {
    const error = new Error(message);
    error.statusCode = 401;
    return error;
}

function resolveScope(context = {}) {
    return context?.scope === 'all' ? 'all' : 'user';
}

function resolveUserId(context = {}) {
    return String(context?.userId || '').trim();
}

function requireUserId(context = {}) {
    const userId = resolveUserId(context);
    if (!userId) {
        throw createUnauthorizedError();
    }
    return userId;
}

function supabaseHeaders(prefer = '') {
    const headers = {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
    };

    if (prefer) {
        headers.Prefer = prefer;
    }

    return headers;
}

function createSupabaseError(error, table) {
    const status = error.response?.status;
    const payload = error.response?.data || {};
    const code = payload.code ? ` ${payload.code}` : '';
    const details = payload.message || payload.error_description || payload.details || error.message;
    const missingTableHint = payload.code === '42P01'
        ? ` Table "${table}" does not exist yet. Run the SQL schema first.`
        : '';

    const wrapped = new Error(`Supabase request failed for ${table} (${status || 'n/a'}${code}): ${details}.${missingTableHint}`);
    wrapped.statusCode = status || 500;
    return wrapped;
}

function normalizeLinkedInState(state) {
    const accounts = (state.accounts || []).filter((item) => item.platform === 'linkedin');
    const accountIds = new Set(accounts.map((item) => item.id));

    const schedules = (state.schedules || []).filter((item) =>
        item.platform === 'linkedin' && accountIds.has(item.accountId)
    );
    const scheduleIds = new Set(schedules.map((item) => item.id));

    const queue = (state.queue || []).filter((item) =>
        item.platform === 'linkedin' &&
        accountIds.has(item.accountId) &&
        scheduleIds.has(item.scheduleId)
    );

    return { accounts, schedules, queue };
}

function toAccountRow(account, context = {}) {
    const userId = String(account.userId || resolveUserId(context) || '').trim();

    return {
        id: account.id,
        user_id: userId || null,
        platform: 'linkedin',
        display_name: account.displayName || 'LinkedIn User',
        access_token: account.accessToken || '',
        author_urn: account.authorUrn || '',
        linkedin_member_id: account.linkedinMemberId || null,
        email: account.email || null,
        profile_picture: account.profilePicture || null,
        auth_type: account.authType || 'oauth',
        status: account.status || 'connected',
        token_expires_at: account.tokenExpiresAt || null,
        created_at: account.createdAt || new Date().toISOString(),
        updated_at: account.updatedAt || new Date().toISOString()
    };
}

function toScheduleRow(schedule, context = {}) {
    const userId = String(schedule.userId || resolveUserId(context) || '').trim();

    return {
        id: schedule.id,
        user_id: userId || null,
        platform: 'linkedin',
        account_id: schedule.accountId,
        company_name: schedule.companyName || '',
        website: schedule.website || '',
        industry: schedule.industry || '',
        services: Array.isArray(schedule.services) ? schedule.services : [],
        country_code: schedule.countryCode || 'US',
        mode: schedule.mode || 'rotation',
        categories: Array.isArray(schedule.categories) ? schedule.categories : ['tech', 'science', 'dental'],
        posts_per_week: Number(schedule.postsPerWeek || 7),
        preferred_hour: Number(schedule.preferredHour || 10),
        start_date: schedule.startDate || new Date().toISOString(),
        end_date: schedule.endDate || new Date().toISOString(),
        active: schedule.active !== false,
        created_at: schedule.createdAt || new Date().toISOString()
    };
}

function toQueueRow(item, context = {}) {
    const userId = String(item.userId || resolveUserId(context) || '').trim();

    return {
        id: item.id,
        user_id: userId || null,
        schedule_id: item.scheduleId,
        account_id: item.accountId,
        platform: 'linkedin',
        status: item.status || 'scheduled',
        scheduled_for: item.scheduledFor || new Date().toISOString(),
        created_at: item.createdAt || new Date().toISOString(),
        updated_at: item.updatedAt || null,
        published_at: item.publishedAt || null,
        content: item.content || '',
        metadata: item.metadata || {},
        provider_id: item.providerId || null,
        provider_response: item.providerResponse || null,
        error: item.error || null,
        error_status: item.errorStatus || null
    };
}

function fromAccountRow(row) {
    return {
        id: row.id,
        userId: row.user_id || '',
        platform: row.platform,
        displayName: row.display_name || '',
        accessToken: row.access_token || '',
        authorUrn: row.author_urn || '',
        linkedinMemberId: row.linkedin_member_id || '',
        email: row.email || '',
        profilePicture: row.profile_picture || '',
        authType: row.auth_type || '',
        status: row.status || '',
        tokenExpiresAt: row.token_expires_at || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function fromScheduleRow(row) {
    return {
        id: row.id,
        userId: row.user_id || '',
        platform: row.platform,
        accountId: row.account_id,
        companyName: row.company_name || '',
        website: row.website || '',
        industry: row.industry || '',
        services: Array.isArray(row.services) ? row.services : [],
        countryCode: row.country_code || 'US',
        mode: row.mode || 'rotation',
        categories: Array.isArray(row.categories) ? row.categories : ['tech', 'science', 'dental'],
        postsPerWeek: row.posts_per_week,
        preferredHour: row.preferred_hour,
        startDate: row.start_date,
        endDate: row.end_date,
        active: row.active,
        createdAt: row.created_at
    };
}

function fromQueueRow(row) {
    return {
        id: row.id,
        userId: row.user_id || '',
        scheduleId: row.schedule_id,
        accountId: row.account_id,
        platform: row.platform,
        status: row.status,
        scheduledFor: row.scheduled_for,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        publishedAt: row.published_at,
        content: row.content || '',
        metadata: row.metadata || {},
        providerId: row.provider_id,
        providerResponse: row.provider_response,
        error: row.error,
        errorStatus: row.error_status
    };
}

async function ensureStateFile() {
    await fs.mkdir(dataDir, { recursive: true });
    try {
        await fs.access(statePath);
    } catch (error) {
        await fs.writeFile(statePath, JSON.stringify({ users: {}, profiles: {} }, null, 2), 'utf8');
    }
}

function normalizeLocalContainer(parsed) {
    if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
        if (!parsed.profiles || typeof parsed.profiles !== 'object') {
            parsed.profiles = {};
        }
        return parsed;
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
        return {
            users: {
                shared: {
                    accounts: parsed.accounts || [],
                    schedules: parsed.schedules || [],
                    queue: parsed.queue || []
                }
            },
            profiles: {}
        };
    }

    return { users: {}, profiles: {} };
}

async function readLocalContainer() {
    await ensureStateFile();
    const raw = await fs.readFile(statePath, 'utf8');

    try {
        return normalizeLocalContainer(JSON.parse(raw));
    } catch (error) {
        return { users: {} };
    }
}

async function writeLocalContainer(container) {
    await ensureStateFile();
    await fs.writeFile(statePath, JSON.stringify(container, null, 2), 'utf8');
}

function localUserKey(context = {}) {
    const userId = resolveUserId(context);
    return userId || 'shared';
}

async function readLocalState(context = {}) {
    const container = await readLocalContainer();
    const key = localUserKey(context);
    const state = container.users[key] || cloneDefaultState();

    return {
        accounts: state.accounts || [],
        schedules: state.schedules || [],
        queue: state.queue || []
    };
}

async function writeLocalState(state, context = {}) {
    const container = await readLocalContainer();
    const key = localUserKey(context);
    container.users[key] = normalizeLinkedInState(state);
    await writeLocalContainer(container);
    return container.users[key];
}

function toInFilter(ids) {
    return `in.(${ids.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',')})`;
}

function difference(sourceIds, keepIdsSet) {
    return sourceIds.filter((id) => !keepIdsSet.has(id));
}

function upsertRecord(list, record) {
    const index = list.findIndex((item) => item.id === record.id);
    if (index >= 0) {
        list[index] = record;
        return;
    }

    list.push(record);
}

function buildUserFilterParams(params = {}, context = {}) {
    if (resolveScope(context) === 'all') {
        return params;
    }

    const userId = requireUserId(context);
    return {
        ...params,
        user_id: `eq.${userId}`
    };
}

async function fetchSupabaseRows(table, orderColumn, context = {}) {
    try {
        const response = await axios.get(`${SUPABASE_REST_BASE}/${table}`, {
            params: buildUserFilterParams({
                select: '*',
                order: `${orderColumn}.asc`
            }, context),
            headers: supabaseHeaders()
        });
        return response.data || [];
    } catch (error) {
        throw createSupabaseError(error, table);
    }
}

async function fetchSupabaseIds(table, context = {}) {
    try {
        const response = await axios.get(`${SUPABASE_REST_BASE}/${table}`, {
            params: buildUserFilterParams({ select: 'id' }, context),
            headers: supabaseHeaders()
        });
        return (response.data || []).map((row) => row.id);
    } catch (error) {
        throw createSupabaseError(error, table);
    }
}

async function upsertSupabaseRows(table, rows) {
    if (!rows.length) {
        return;
    }

    try {
        await axios.post(`${SUPABASE_REST_BASE}/${table}`, rows, {
            params: { on_conflict: 'id' },
            headers: supabaseHeaders('resolution=merge-duplicates,return=minimal')
        });
    } catch (error) {
        throw createSupabaseError(error, table);
    }
}

async function deleteSupabaseRowsById(table, ids, context = {}) {
    if (!ids.length) {
        return;
    }

    const chunkSize = 200;
    for (let index = 0; index < ids.length; index += chunkSize) {
        const chunk = ids.slice(index, index + chunkSize);
        try {
            await axios.delete(`${SUPABASE_REST_BASE}/${table}`, {
                params: buildUserFilterParams({ id: toInFilter(chunk) }, context),
                headers: supabaseHeaders('return=minimal')
            });
        } catch (error) {
            throw createSupabaseError(error, table);
        }
    }
}

async function patchSupabaseRows(table, filters, patch, context = {}) {
    try {
        await axios.patch(`${SUPABASE_REST_BASE}/${table}`, patch, {
            params: buildUserFilterParams({ ...filters }, context),
            headers: supabaseHeaders('return=minimal')
        });
    } catch (error) {
        throw createSupabaseError(error, table);
    }
}

async function readSupabaseState(context = {}) {
    const [accountRows, scheduleRows, queueRows] = await Promise.all([
        fetchSupabaseRows('accounts', 'created_at', context),
        fetchSupabaseRows('schedules', 'created_at', context),
        fetchSupabaseRows('queue_items', 'created_at', context)
    ]);

    return {
        accounts: accountRows.map(fromAccountRow),
        schedules: scheduleRows.map(fromScheduleRow),
        queue: queueRows.map(fromQueueRow)
    };
}

async function writeSupabaseState(state, context = {}) {
    const normalized = normalizeLinkedInState(state);
    const accountRows = normalized.accounts.map((row) => toAccountRow(row, context));
    const scheduleRows = normalized.schedules.map((row) => toScheduleRow(row, context));
    const queueRows = normalized.queue.map((row) => toQueueRow(row, context));

    const [existingAccountIds, existingScheduleIds, existingQueueIds] = await Promise.all([
        fetchSupabaseIds('accounts', context),
        fetchSupabaseIds('schedules', context),
        fetchSupabaseIds('queue_items', context)
    ]);

    await upsertSupabaseRows('accounts', accountRows);
    await upsertSupabaseRows('schedules', scheduleRows);
    await upsertSupabaseRows('queue_items', queueRows);

    const accountIdsSet = new Set(accountRows.map((row) => row.id));
    const scheduleIdsSet = new Set(scheduleRows.map((row) => row.id));
    const queueIdsSet = new Set(queueRows.map((row) => row.id));

    await deleteSupabaseRowsById('queue_items', difference(existingQueueIds, queueIdsSet), context);
    await deleteSupabaseRowsById('schedules', difference(existingScheduleIds, scheduleIdsSet), context);
    await deleteSupabaseRowsById('accounts', difference(existingAccountIds, accountIdsSet), context);

    return normalized;
}

async function readState(context = {}) {
    if (isSupabaseEnabled && !context.localOnly) {
        try {
            return await readSupabaseState(context);
        } catch (error) {
            console.warn(`[publishingStore] Supabase read failed, falling back to local storage: ${error.message}`);
            return readLocalState(context);
        }
    }
    return readLocalState(context);
}

async function writeState(state, context = {}) {
    if (isSupabaseEnabled && !context.localOnly) {
        try {
            return await writeSupabaseState(state, context);
        } catch (error) {
            console.warn(`[publishingStore] Supabase write failed, falling back to local storage: ${error.message}`);
            return writeLocalState(state, context);
        }
    }
    return writeLocalState(state, context);
}

async function saveAccount(account, context = {}) {
    if (isSupabaseEnabled) {
        const row = toAccountRow(account, context);
        await upsertSupabaseRows('accounts', [row]);
        return { ...account, userId: row.user_id };
    }

    const state = await readLocalState(context);
    upsertRecord(state.accounts, account);
    await writeLocalState(state, context);
    return account;
}

async function saveSchedule(schedule, context = {}) {
    if (isSupabaseEnabled) {
        const row = toScheduleRow(schedule, context);
        await upsertSupabaseRows('schedules', [row]);
        return { ...schedule, userId: row.user_id };
    }

    const state = await readLocalState(context);
    upsertRecord(state.schedules, schedule);
    await writeLocalState(state, context);
    return schedule;
}

async function saveQueueItems(queueItems, context = {}) {
    if (!Array.isArray(queueItems) || !queueItems.length) {
        return [];
    }

    if (isSupabaseEnabled) {
        const rows = queueItems.map((item) => toQueueRow(item, context));
        await upsertSupabaseRows('queue_items', rows);
        return queueItems.map((item, index) => ({ ...item, userId: rows[index].user_id }));
    }

    const state = await readLocalState(context);
    queueItems.forEach((item) => upsertRecord(state.queue, item));
    await writeLocalState(state, context);
    return queueItems;
}

async function saveQueueItem(queueItem, context = {}) {
    const [saved] = await saveQueueItems([queueItem], context);
    return saved;
}

function buildQueueUpdatePayload(patch) {
    const updatePayload = {};

    if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
        updatePayload.status = patch.status;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'updatedAt')) {
        updatePayload.updated_at = patch.updatedAt;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'publishedAt')) {
        updatePayload.published_at = patch.publishedAt;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'providerId')) {
        updatePayload.provider_id = patch.providerId;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'providerResponse')) {
        updatePayload.provider_response = patch.providerResponse;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
        updatePayload.error = patch.error;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'errorStatus')) {
        updatePayload.error_status = patch.errorStatus;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
        updatePayload.content = patch.content;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) {
        updatePayload.metadata = patch.metadata;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'scheduledFor')) {
        updatePayload.scheduled_for = patch.scheduledFor;
    }

    return updatePayload;
}

async function updateQueueItemStatus(queueItemId, patch, context = {}) {
    if (isSupabaseEnabled) {
        await patchSupabaseRows('queue_items', { id: `eq.${queueItemId}` }, buildQueueUpdatePayload(patch), context);
        return queueItemId;
    }

    const state = await readLocalState(context);
    const queueItem = state.queue.find((item) => item.id === queueItemId);
    if (!queueItem) {
        return null;
    }

    Object.assign(queueItem, patch);
    await writeLocalState(state, context);
    return queueItem;
}

async function updateQueueItem(queueItemId, patch, context = {}) {
    if (isSupabaseEnabled) {
        await patchSupabaseRows('queue_items', { id: `eq.${queueItemId}` }, buildQueueUpdatePayload(patch), context);
        return queueItemId;
    }

    const state = await readLocalState(context);
    const queueItem = state.queue.find((item) => item.id === queueItemId);
    if (!queueItem) {
        return null;
    }

    Object.assign(queueItem, patch);
    await writeLocalState(state, context);
    return queueItem;
}

// Removes queue items by id for the user in `context` (the user filter is
// applied to the delete itself, so one person can never remove another's).
async function deleteQueueItems(queueItemIds, context = {}) {
    const ids = (queueItemIds || []).filter(Boolean);
    if (!ids.length) {
        return 0;
    }

    if (isSupabaseEnabled && !context.localOnly) {
        await deleteSupabaseRowsById('queue_items', ids, context);
        return ids.length;
    }

    const state = await readLocalState(context);
    const before = state.queue.length;
    state.queue = state.queue.filter((item) => !ids.includes(item.id));
    await writeLocalState(state, context);
    return before - state.queue.length;
}

// Removes a schedule together with every queue item that belongs to it.
async function deleteSchedule(scheduleId, context = {}) {
    if (isSupabaseEnabled && !context.localOnly) {
        const state = await readSupabaseState(context);
        const queueIds = state.queue.filter((item) => item.scheduleId === scheduleId).map((item) => item.id);
        await deleteSupabaseRowsById('queue_items', queueIds, context);
        await deleteSupabaseRowsById('schedules', [scheduleId], context);
        return { removedQueueItems: queueIds.length };
    }

    const state = await readLocalState(context);
    const before = state.queue.length;
    state.queue = state.queue.filter((item) => item.scheduleId !== scheduleId);
    state.schedules = state.schedules.filter((item) => item.id !== scheduleId);
    await writeLocalState(state, context);
    return { removedQueueItems: before - state.queue.length };
}

function createId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Profiles — one row per person who has ever signed in with LinkedIn. This is
// deliberately a separate table from `accounts` (which is about connected
// LinkedIn *publishing* credentials): a profile is identity, an account is a
// posting connection. telegram_chat_id/telegram_link_code are how a specific
// Telegram chat gets tied to a specific signed-in person, so scheduled-post
// confirmations only ever reach the person who owns that queue item.
// ---------------------------------------------------------------------------

function toProfileRow(profile) {
    return {
        id: profile.id,
        email: profile.email || null,
        display_name: profile.displayName || null,
        profile_picture: profile.profilePicture || null,
        telegram_chat_id: profile.telegramChatId || null,
        telegram_link_code: profile.telegramLinkCode || null,
        telegram_link_code_expires_at: profile.telegramLinkCodeExpiresAt || null,
        created_at: profile.createdAt || new Date().toISOString(),
        last_login_at: profile.lastLoginAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

function fromProfileRow(row) {
    return {
        id: row.id,
        email: row.email || '',
        displayName: row.display_name || '',
        profilePicture: row.profile_picture || '',
        telegramChatId: row.telegram_chat_id || '',
        telegramLinkCode: row.telegram_link_code || '',
        telegramLinkCodeExpiresAt: row.telegram_link_code_expires_at || '',
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        updatedAt: row.updated_at
    };
}

async function readLocalProfile(userId) {
    const container = await readLocalContainer();
    const row = container.profiles?.[userId];
    return row || null;
}

async function writeLocalProfile(userId, profile) {
    const container = await readLocalContainer();
    if (!container.profiles) {
        container.profiles = {};
    }
    container.profiles[userId] = profile;
    await writeLocalContainer(container);
    return profile;
}

async function findLocalProfileByTelegramChatId(chatId) {
    const container = await readLocalContainer();
    const profiles = container.profiles || {};
    const strChatId = String(chatId);
    return Object.values(profiles).find((p) => String(p.telegramChatId || '') === strChatId) || null;
}

async function findLocalProfileByLinkCode(code) {
    const container = await readLocalContainer();
    const profiles = container.profiles || {};
    return Object.values(profiles).find((p) => p.telegramLinkCode === code) || null;
}

// Called on every successful LinkedIn sign-in. Creates the profile on first
// login, otherwise just refreshes last_login_at / display info.
async function upsertProfile({ id, email, displayName, profilePicture }) {
    const userId = String(id || '').trim();
    if (!userId) {
        throw new Error('upsertProfile requires an id.');
    }

    if (isSupabaseEnabled) {
        try {
            const response = await axios.get(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                params: { id: `eq.${userId}`, select: '*' },
                headers: supabaseHeaders()
            });
            const existing = (response.data || [])[0] || null;

            const row = toProfileRow({
                id: userId,
                email: email || existing?.email,
                displayName: displayName || existing?.display_name,
                profilePicture: profilePicture || existing?.profile_picture,
                telegramChatId: existing?.telegram_chat_id,
                telegramLinkCode: existing?.telegram_link_code,
                telegramLinkCodeExpiresAt: existing?.telegram_link_code_expires_at,
                createdAt: existing?.created_at
            });

            await axios.post(`${SUPABASE_REST_BASE}/postcraft_profiles`, [row], {
                headers: supabaseHeaders('resolution=merge-duplicates,return=minimal')
            });

            return fromProfileRow(row);
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
    }

    const existing = await readLocalProfile(userId);
    const profile = {
        id: userId,
        email: email || existing?.email || '',
        displayName: displayName || existing?.displayName || '',
        profilePicture: profilePicture || existing?.profilePicture || '',
        telegramChatId: existing?.telegramChatId || '',
        telegramLinkCode: existing?.telegramLinkCode || '',
        telegramLinkCodeExpiresAt: existing?.telegramLinkCodeExpiresAt || '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    await writeLocalProfile(userId, profile);
    return profile;
}

async function getProfile(userId) {
    const id = String(userId || '').trim();
    if (!id) {
        return null;
    }

    if (isSupabaseEnabled) {
        try {
            const response = await axios.get(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                params: { id: `eq.${id}`, select: '*' },
                headers: supabaseHeaders()
            });
            const row = (response.data || [])[0];
            return row ? fromProfileRow(row) : null;
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
    }

    return readLocalProfile(id);
}

// Generates a short-lived one-time code for `https://t.me/<bot>?start=<code>`.
// Only the person currently signed in as `userId` can request this, and only
// someone who opens that exact deep link in Telegram can consume it — that's
// the proof that a given Telegram chat belongs to this app user.
async function createTelegramLinkCode(userId) {
    const id = String(userId || '').trim();
    if (!id) {
        throw new Error('createTelegramLinkCode requires a userId.');
    }

    const code = crypto.randomBytes(9).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    if (isSupabaseEnabled) {
        try {
            await axios.patch(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                telegram_link_code: code,
                telegram_link_code_expires_at: expiresAt,
                updated_at: new Date().toISOString()
            }, {
                params: { id: `eq.${id}` },
                headers: supabaseHeaders('return=minimal')
            });
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
        return { code, expiresAt };
    }

    const existing = await readLocalProfile(id) || { id };
    existing.telegramLinkCode = code;
    existing.telegramLinkCodeExpiresAt = expiresAt;
    await writeLocalProfile(id, existing);
    return { code, expiresAt };
}

// Called by the Telegram bot when it receives /start <code>. Finds which
// profile requested that code (if any, and if it hasn't expired) and links
// this chat to it. Returns the linked profile, or null if the code is
// invalid/expired — the bot uses that to reject stale or made-up codes.
async function linkTelegramChatByCode(code, chatId) {
    const strCode = String(code || '').trim();
    if (!strCode) {
        return null;
    }

    if (isSupabaseEnabled) {
        try {
            const response = await axios.get(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                params: { telegram_link_code: `eq.${strCode}`, select: '*' },
                headers: supabaseHeaders()
            });
            const row = (response.data || [])[0];
            if (!row) {
                return null;
            }
            if (row.telegram_link_code_expires_at && new Date(row.telegram_link_code_expires_at).getTime() < Date.now()) {
                return null;
            }

            await axios.patch(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                telegram_chat_id: String(chatId),
                telegram_link_code: null,
                telegram_link_code_expires_at: null,
                updated_at: new Date().toISOString()
            }, {
                params: { id: `eq.${row.id}` },
                headers: supabaseHeaders('return=minimal')
            });

            return fromProfileRow({ ...row, telegram_chat_id: String(chatId) });
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
    }

    const profile = await findLocalProfileByLinkCode(strCode);
    if (!profile) {
        return null;
    }
    if (profile.telegramLinkCodeExpiresAt && new Date(profile.telegramLinkCodeExpiresAt).getTime() < Date.now()) {
        return null;
    }

    profile.telegramChatId = String(chatId);
    profile.telegramLinkCode = '';
    profile.telegramLinkCodeExpiresAt = '';
    await writeLocalProfile(profile.id, profile);
    return profile;
}

async function unlinkTelegramChat(userId) {
    const id = String(userId || '').trim();
    if (!id) {
        return;
    }

    if (isSupabaseEnabled) {
        try {
            await axios.patch(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                telegram_chat_id: null,
                updated_at: new Date().toISOString()
            }, {
                params: { id: `eq.${id}` },
                headers: supabaseHeaders('return=minimal')
            });
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
        return;
    }

    const existing = await readLocalProfile(id);
    if (existing) {
        existing.telegramChatId = '';
        await writeLocalProfile(id, existing);
    }
}

// Used by the bot to figure out which app user a given Telegram chat belongs
// to, for /verify and for confirming a scheduled post from that chat.
// Every profile that has a linked Telegram chat (used to tell people when
// the Research Playbook changes).
async function listProfilesWithTelegram() {
    if (isSupabaseEnabled) {
        try {
            const response = await axios.get(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                params: { telegram_chat_id: 'not.is.null', select: '*' },
                headers: supabaseHeaders()
            });
            return (response.data || []).map(fromProfileRow);
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
    }

    const container = await readLocalContainer();
    return Object.values(container.profiles || {}).filter((profile) => profile.telegramChatId);
}

async function getProfileByTelegramChatId(chatId) {
    const strChatId = String(chatId || '').trim();
    if (!strChatId) {
        return null;
    }

    if (isSupabaseEnabled) {
        try {
            const response = await axios.get(`${SUPABASE_REST_BASE}/postcraft_profiles`, {
                params: { telegram_chat_id: `eq.${strChatId}`, select: '*' },
                headers: supabaseHeaders()
            });
            const row = (response.data || [])[0];
            return row ? fromProfileRow(row) : null;
        } catch (error) {
            throw createSupabaseError(error, 'postcraft_profiles');
        }
    }

    return findLocalProfileByTelegramChatId(strChatId);
}

module.exports = {
    readState,
    writeState,
    saveAccount,
    saveSchedule,
    saveQueueItems,
    saveQueueItem,
    updateQueueItemStatus,
    updateQueueItem,
    deleteQueueItems,
    deleteSchedule,
    createId,
    upsertProfile,
    getProfile,
    createTelegramLinkCode,
    linkTelegramChatByCode,
    unlinkTelegramChat,
    getProfileByTelegramChatId,
    listProfilesWithTelegram
};
