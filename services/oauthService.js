const crypto = require('crypto');
const axios = require('axios');
const { readState, saveAccount, createId } = require('./publishingStore');

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function getSiteUrl(options = {}) {
    const configuredUrl = trimTrailingSlash(process.env.PUBLIC_SITE_URL);

    if (configuredUrl) {
        return configuredUrl;
    }

    const headers = options.headers || {};
    const host = headers['x-forwarded-host'] || headers.host || '';
    const protocol = headers['x-forwarded-proto'] || (host && host.includes('localhost') ? 'http' : 'https');

    if (host) {
        return `${protocol}://${host}`;
    }

    return trimTrailingSlash(options.defaultUrl || `http://localhost:${process.env.PORT || 3000}`);
}

function getLinkedInOAuthConfig(options = {}) {
    const siteUrl = getSiteUrl(options);
    return {
        clientId: String(process.env.LINKEDIN_CLIENT_ID || '').trim(),
        clientSecret: String(process.env.LINKEDIN_CLIENT_SECRET || '').trim(),
        redirectUri: String(
            process.env.LINKEDIN_REDIRECT_URI ||
            `${siteUrl}/auth/linkedin/callback`
        ).trim(),
        scope: String(process.env.LINKEDIN_SCOPE || 'openid profile email w_member_social').trim(),
        siteUrl
    };
}

function isLinkedInOAuthConfigured(options = {}) {
    const config = getLinkedInOAuthConfig(options);
    return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

function getStateSecret(config) {
    return String(process.env.LINKEDIN_OAUTH_STATE_SECRET || config.clientSecret || '').trim();
}

function toBase64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function signStatePayload(encodedPayload, config) {
    return crypto
        .createHmac('sha256', getStateSecret(config))
        .update(encodedPayload)
        .digest('base64url');
}

function createOAuthStateToken(config, metadata = {}) {
    const payload = {
        provider: 'linkedin',
        nonce: crypto.randomBytes(24).toString('hex'),
        issuedAt: Date.now(),
        userId: String(metadata.userId || '').trim() || null,
        returnTo: String(metadata.returnTo || '').trim() || '/publisher.html'
    };
    const encodedPayload = toBase64Url(JSON.stringify(payload));
    const signature = signStatePayload(encodedPayload, config);
    return `${encodedPayload}.${signature}`;
}

function verifyOAuthStateToken(stateToken, config) {
    if (!stateToken || !stateToken.includes('.')) {
        return null;
    }

    const [encodedPayload, signature] = stateToken.split('.');
    const expectedSignature = signStatePayload(encodedPayload, config);

    if (signature.length !== expectedSignature.length) {
        return null;
    }

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        if (payload.provider !== 'linkedin') {
            return null;
        }

        const isFresh = Date.now() - Number(payload.issuedAt || 0) <= (10 * 60 * 1000);
        if (!isFresh) {
            return null;
        }

        return payload;
    } catch (error) {
        return null;
    }
}

async function fetchLinkedInUserInfo(accessToken) {
    try {
        const response = await axios.get('https://api.linkedin.com/v2/userinfo', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        return response.data || {};
    } catch (error) {
        return {};
    }
}

async function upsertLinkedInOAuthAccount({ accessToken, expiresIn, profile, userContext }) {
    const memberId = profile.sub || '';
    const authorUrn = memberId ? `urn:li:person:${memberId}` : '';
    const userId = String(userContext?.userId || '').trim();

    if (!userId) {
        throw new Error('A valid authenticated user is required before connecting LinkedIn.');
    }

    if (!authorUrn) {
        throw new Error('LinkedIn login succeeded but the profile did not include a member ID.');
    }

    const state = await readState({ userId });
    const now = new Date().toISOString();
    const displayName = profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || 'LinkedIn User';
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + (Number(expiresIn) * 1000)).toISOString() : '';

    const existingAccount = state.accounts.find((account) =>
        account.platform === 'linkedin' && (
            account.authorUrn === authorUrn ||
            (memberId && account.linkedinMemberId === memberId)
        )
    );

    const account = {
        id: existingAccount?.id || createId('account'),
        userId,
        platform: 'linkedin',
        displayName,
        accessToken,
        authorUrn,
        linkedinMemberId: memberId,
        email: profile.email || '',
        profilePicture: profile.picture || '',
        authType: 'oauth',
        status: 'connected',
        createdAt: existingAccount?.createdAt || now,
        updatedAt: now,
        tokenExpiresAt
    };

    await saveAccount(account, { userId });
    return account;
}

// ---------------------------------------------------------------------------
// App session tokens. These are what actually keep two different people
// signed in as themselves. After a successful LinkedIn OAuth callback, the
// server mints one of these (HMAC-signed, same secret/style as the state
// token above) and sets it as an httpOnly cookie. It is NOT the same thing
// as the state token — the "type" field below stops one from ever being
// accepted as the other — and it can't be edited by the browser because the
// signature covers the payload and only the server knows the secret.
// ---------------------------------------------------------------------------
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSessionToken(config, { userId, email, displayName, linkedinMemberId }) {
    const payload = {
        type: 'postcraft_session',
        userId: String(userId || '').trim(),
        email: String(email || '').trim(),
        displayName: String(displayName || '').trim(),
        linkedinMemberId: String(linkedinMemberId || '').trim(),
        issuedAt: Date.now()
    };
    const encodedPayload = toBase64Url(JSON.stringify(payload));
    const signature = signStatePayload(encodedPayload, config);
    return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token, config) {
    if (!token || !token.includes('.')) {
        return null;
    }

    const [encodedPayload, signature] = token.split('.');
    const expectedSignature = signStatePayload(encodedPayload, config);

    if (signature.length !== expectedSignature.length) {
        return null;
    }

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        if (payload.type !== 'postcraft_session' || !payload.userId) {
            return null;
        }

        const isFresh = Date.now() - Number(payload.issuedAt || 0) <= SESSION_MAX_AGE_MS;
        if (!isFresh) {
            return null;
        }

        return payload;
    } catch (error) {
        return null;
    }
}

module.exports = {
    getSiteUrl,
    getLinkedInOAuthConfig,
    isLinkedInOAuthConfigured,
    createOAuthStateToken,
    verifyOAuthStateToken,
    fetchLinkedInUserInfo,
    upsertLinkedInOAuthAccount,
    createSessionToken,
    verifySessionToken,
    SESSION_MAX_AGE_MS
};
