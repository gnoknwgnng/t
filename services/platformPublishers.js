const axios = require('axios');

async function publishLinkedIn(account, queueItem) {
    if (!account.accessToken || !account.authorUrn) {
        throw new Error('LinkedIn publishing requires accessToken and authorUrn.');
    }

    const payload = {
        author: account.authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
            'com.linkedin.ugc.ShareContent': {
                shareCommentary: {
                    text: queueItem.content
                },
                shareMediaCategory: 'NONE'
            }
        },
        visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
    };

    const response = await axios.post('https://api.linkedin.com/v2/ugcPosts', payload, {
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0'
        }
    });

    return {
        providerId: response.headers['x-restli-id'] || response.data?.id || null,
        providerResponse: response.data || null
    };
}

// Adds a comment to one of the account's own posts (used for the
// "link in first comment" mode). `postUrn` is the id LinkedIn returned when
// the post was published.
async function commentOnLinkedInPost(account, postUrn, text) {
    if (!account.accessToken || !account.authorUrn || !postUrn) {
        throw new Error('LinkedIn commenting needs accessToken, authorUrn and the post id.');
    }

    const response = await axios.post(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}/comments`,
        { actor: account.authorUrn, object: postUrn, message: { text } },
        {
            headers: {
                Authorization: `Bearer ${account.accessToken}`,
                'Content-Type': 'application/json',
                'X-Restli-Protocol-Version': '2.0.0'
            }
        }
    );
    return response.data || null;
}

async function publishToPlatform(platform, account, queueItem) {
    if (platform !== 'linkedin') {
        throw new Error(`Unsupported platform: ${platform}. Only linkedin is enabled.`);
    }

    return publishLinkedIn(account, queueItem);
}

module.exports = {
    publishToPlatform,
    commentOnLinkedInPost
};
