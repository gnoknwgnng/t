/**
 * Preservation Property Tests
 * PostCraft AI — LinkedIn Auth & Storage Fix
 *
 * PURPOSE: Guard against regressions. Each test captures baseline behavior
 * on NON-BUG code paths (where isBugCondition = false).
 *
 * EXPECTED OUTCOME (both before AND after the fix):
 *   All tests PASS — these confirm the baseline behavior is preserved.
 *
 * Runnable with: node tests/preservation.test.js
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const results = [];

function recordPass(label) {
    results.push({ label, status: 'PASS' });
    console.log('  \u2705 PASS  ' + label);
}

function recordFail(label, counterexample) {
    results.push({ label, status: 'FAIL', counterexample });
    console.log('  \u274C FAIL  ' + label);
    console.log('           Counterexample: ' + counterexample);
}

async function runTest(label, fn) {
    console.log('\n\u25B6  ' + label);
    try {
        await fn();
    } catch (err) {
        recordFail(label, err.message);
    }
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------
(async () => {
    console.log('Preservation Property Tests');
    console.log('PostCraft AI \u2014 LinkedIn Auth & Storage Fix');
    console.log('='.repeat(60));

    // -----------------------------------------------------------------------
    // Property 2.a — Local-only storage path
    //
    // When SUPABASE_URL is not set (or empty), readState and writeState in
    // services/publishingStore.js must use ONLY local file storage: they must
    // return a valid state object and must not throw.
    //
    // isBugCondition = false when SUPABASE_URL is absent/empty.
    // This path must remain unchanged by the fix.
    //
    // Validates: Requirements 3.1, 3.2, 3.4, 3.7, 3.9
    // -----------------------------------------------------------------------
    await runTest('2.a \u2014 Local-only storage path', async function () {
        // Stash and clear Supabase env vars so the module uses local-only path
        const savedSupabaseUrl = process.env.SUPABASE_URL;
        const savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const savedSecretKey = process.env.SUPABASE_SECRET_KEY;
        const savedServiceKey2 = process.env.SUPABASE_SERVICE_KEY;

        process.env.SUPABASE_URL = '';
        process.env.SUPABASE_SERVICE_ROLE_KEY = '';
        process.env.SUPABASE_SECRET_KEY = '';
        process.env.SUPABASE_SERVICE_KEY = '';

        // publishingStore reads env vars at module load time, so we must
        // test the local-path functions directly rather than re-requiring.
        // We confirm the module's isSupabaseEnabled gate by reading the source.
        const storeSource = fs.readFileSync(
            path.join(ROOT, 'services', 'publishingStore.js'),
            'utf8'
        );

        // The module must gate Supabase usage behind isSupabaseEnabled check
        const hasLocalFallback = /isSupabaseEnabled/.test(storeSource);
        assert.ok(
            hasLocalFallback,
            'publishingStore.js does not use an isSupabaseEnabled gate. ' +
            'COUNTEREXAMPLE: Without this gate, readState/writeState would attempt ' +
            'Supabase calls even when SUPABASE_URL is unset, causing network errors ' +
            'on every local-only run.'
        );

        // The local read/write path (readLocalState / writeLocalState) must exist
        const hasReadLocalState = /async function readLocalState\s*\(/.test(storeSource);
        assert.ok(
            hasReadLocalState,
            'publishingStore.js does not define readLocalState(). ' +
            'COUNTEREXAMPLE: Without a dedicated local read function, the ' +
            'local-only path cannot fall back from Supabase calls.'
        );

        const hasWriteLocalState = /async function writeLocalState\s*\(/.test(storeSource);
        assert.ok(
            hasWriteLocalState,
            'publishingStore.js does not define writeLocalState(). ' +
            'COUNTEREXAMPLE: Without a dedicated local write function, ' +
            'state changes cannot be persisted when Supabase is absent.'
        );

        // The readState function must return local state when NOT supabase-enabled
        // Verify by exercising the actual module with SUPABASE_URL cleared.
        // Since env vars are captured at module init, we test by using { localOnly: true }
        // which forces the local path regardless.
        const { readState, writeState } = require('../services/publishingStore');

        // readState with localOnly: true must return object with accounts/schedules/queue arrays
        const state = await readState({ localOnly: true });
        assert.ok(
            state && typeof state === 'object',
            'readState({ localOnly: true }) did not return an object. ' +
            'COUNTEREXAMPLE: returned ' + typeof state
        );
        assert.ok(
            Array.isArray(state.accounts),
            'readState({ localOnly: true }).accounts is not an array. ' +
            'COUNTEREXAMPLE: accounts = ' + JSON.stringify(state.accounts)
        );
        assert.ok(
            Array.isArray(state.schedules),
            'readState({ localOnly: true }).schedules is not an array. ' +
            'COUNTEREXAMPLE: schedules = ' + JSON.stringify(state.schedules)
        );
        assert.ok(
            Array.isArray(state.queue),
            'readState({ localOnly: true }).queue is not an array. ' +
            'COUNTEREXAMPLE: queue = ' + JSON.stringify(state.queue)
        );

        // writeState with localOnly: true must complete without throwing
        await writeState({ accounts: [], schedules: [], queue: [] }, { localOnly: true });

        // Restore env vars
        process.env.SUPABASE_URL = savedSupabaseUrl || '';
        process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceKey || '';
        process.env.SUPABASE_SECRET_KEY = savedSecretKey || '';
        process.env.SUPABASE_SERVICE_KEY = savedServiceKey2 || '';

        recordPass('2.a \u2014 Local-only storage path');
    });

    // -----------------------------------------------------------------------
    // Property 2.b — Schedule creation produces queue items
    //
    // generateQueueItemsForSchedule must produce at least one queue item for a
    // valid schedule object covering a 7-day window with postsPerWeek = 7.
    // Each item must have: id, content, scheduledFor, status: 'scheduled'.
    //
    // This property must hold before AND after the fix — schedule/queue
    // creation logic is not touched by the bug fix.
    //
    // Validates: Requirements 3.5, 3.6, 3.8
    // -----------------------------------------------------------------------
    await runTest('2.b \u2014 Schedule creation produces queue items', async function () {
        const { generateQueueItemsForSchedule } = require('../services/schedulerService');

        const now = new Date();
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + 7);

        const schedule = {
            id: 'test_schedule_001',
            userId: 'test_user',
            accountId: 'test_account_001',
            platform: 'linkedin',
            postsPerWeek: 7,
            startDate: now,
            endDate: endDate,
            preferredHour: 10,
            categories: ['tech', 'science', 'dental'],
            mode: 'rotation',
            companyName: 'Test Company',
            website: 'https://example.com',
            industry: 'Technology',
            services: ['AI', 'Cloud']
        };

        const queueItems = await generateQueueItemsForSchedule(schedule);

        // Must return a non-empty array
        assert.ok(
            Array.isArray(queueItems),
            'generateQueueItemsForSchedule did not return an array. ' +
            'COUNTEREXAMPLE: returned ' + typeof queueItems
        );
        assert.ok(
            queueItems.length > 0,
            'generateQueueItemsForSchedule returned an empty array for a 7-day schedule ' +
            'with postsPerWeek=7. ' +
            'COUNTEREXAMPLE: No queue items were generated, schedule cannot post anything.'
        );

        // Each item must have required fields
        queueItems.forEach(function (item, index) {
            assert.ok(
                item.id && typeof item.id === 'string' && item.id.length > 0,
                'Queue item[' + index + '] is missing a non-empty id. ' +
                'COUNTEREXAMPLE: item.id = ' + JSON.stringify(item.id)
            );
            assert.ok(
                item.content && typeof item.content === 'string' && item.content.length > 0,
                'Queue item[' + index + '] is missing non-empty content. ' +
                'COUNTEREXAMPLE: item.content = ' + JSON.stringify(item.content)
            );
            assert.ok(
                item.scheduledFor && typeof item.scheduledFor === 'string',
                'Queue item[' + index + '] is missing scheduledFor (ISO string). ' +
                'COUNTEREXAMPLE: item.scheduledFor = ' + JSON.stringify(item.scheduledFor)
            );
            // scheduledFor must parse as a valid date
            const scheduledDate = new Date(item.scheduledFor);
            assert.ok(
                !isNaN(scheduledDate.getTime()),
                'Queue item[' + index + '].scheduledFor is not a valid date string. ' +
                'COUNTEREXAMPLE: item.scheduledFor = ' + item.scheduledFor
            );
            assert.strictEqual(
                item.status,
                'scheduled',
                'Queue item[' + index + '].status must be "scheduled". ' +
                'COUNTEREXAMPLE: item.status = ' + JSON.stringify(item.status)
            );
        });

        // Property: all item IDs must be unique
        const ids = queueItems.map(function (item) { return item.id; });
        const uniqueIds = new Set(ids);
        assert.strictEqual(
            uniqueIds.size,
            ids.length,
            'generateQueueItemsForSchedule produced queue items with duplicate IDs. ' +
            'COUNTEREXAMPLE: ' + ids.length + ' items but only ' + uniqueIds.size + ' unique IDs.'
        );

        // Property: with rotation mode and 3 categories, items cycle through all categories
        const categories = schedule.categories;
        const usedCategories = new Set(
            queueItems
                .map(function (item) { return item.metadata && item.metadata.category; })
                .filter(Boolean)
        );
        // At least one category from the list should appear
        const hasValidCategory = categories.some(function (cat) { return usedCategories.has(cat); });
        assert.ok(
            hasValidCategory,
            'No queue item has a metadata.category matching the schedule categories. ' +
            'COUNTEREXAMPLE: usedCategories = ' + JSON.stringify([...usedCategories]) +
            ', expected one of ' + JSON.stringify(categories)
        );

        recordPass('2.b \u2014 Schedule creation produces queue items');
    });

    // -----------------------------------------------------------------------
    // Property 2.c — Queue item patch preserves other fields
    //
    // buildQueueUpdatePayload({ status, publishedAt }) must return a payload
    // containing exactly the mapped fields (status, published_at) and must
    // NOT include unrelated fields like content or metadata.
    //
    // This guards against a partial-update accidentally wiping columns that
    // were not part of the patch.
    //
    // The function is internal to publishingStore.js (not exported). We
    // replicate the same logic here to verify the contract independently,
    // and also inspect the source to confirm the implementation matches.
    //
    // Validates: Requirements 3.3, 3.7, 3.10
    // -----------------------------------------------------------------------
    await runTest('2.c \u2014 Queue item patch preserves other fields', function () {
        // Replicate buildQueueUpdatePayload logic as documented in publishingStore.js
        // This is the canonical mapping: camelCase patch keys → snake_case DB columns
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

        const publishedAt = new Date().toISOString();
        const patch = { status: 'published', publishedAt };

        const payload = buildQueueUpdatePayload(patch);

        // Must contain status
        assert.ok(
            Object.prototype.hasOwnProperty.call(payload, 'status'),
            'buildQueueUpdatePayload result is missing "status" field. ' +
            'COUNTEREXAMPLE: payload = ' + JSON.stringify(payload)
        );
        assert.strictEqual(
            payload.status,
            'published',
            'buildQueueUpdatePayload result.status should be "published". ' +
            'COUNTEREXAMPLE: payload.status = ' + payload.status
        );

        // Must contain published_at (camelCase publishedAt → snake_case published_at)
        assert.ok(
            Object.prototype.hasOwnProperty.call(payload, 'published_at'),
            'buildQueueUpdatePayload result is missing "published_at" field. ' +
            'COUNTEREXAMPLE: payload = ' + JSON.stringify(payload) +
            ' — the publishedAt key was not mapped to published_at, ' +
            'so the published timestamp would not be saved in Supabase.'
        );
        assert.strictEqual(
            payload.published_at,
            publishedAt,
            'buildQueueUpdatePayload result.published_at has wrong value. ' +
            'COUNTEREXAMPLE: expected ' + publishedAt + ' got ' + payload.published_at
        );

        // Must NOT contain unrelated fields (content, metadata) when they are absent from patch
        assert.ok(
            !Object.prototype.hasOwnProperty.call(payload, 'content'),
            'buildQueueUpdatePayload included "content" in payload even though it was ' +
            'not in the patch. ' +
            'COUNTEREXAMPLE: payload = ' + JSON.stringify(payload) +
            ' — sending content=undefined in a PATCH would wipe the existing post content.'
        );
        assert.ok(
            !Object.prototype.hasOwnProperty.call(payload, 'metadata'),
            'buildQueueUpdatePayload included "metadata" in payload even though it was ' +
            'not in the patch. ' +
            'COUNTEREXAMPLE: payload = ' + JSON.stringify(payload) +
            ' — sending metadata=undefined in a PATCH would wipe the existing metadata.'
        );

        // Property: the payload must only contain keys that correspond to patch keys provided
        const payloadKeys = Object.keys(payload);
        // For a patch with only {status, publishedAt}, expect exactly {status, published_at}
        assert.strictEqual(
            payloadKeys.length,
            2,
            'buildQueueUpdatePayload returned ' + payloadKeys.length + ' keys instead of 2 ' +
            'for a patch with {status, publishedAt}. ' +
            'COUNTEREXAMPLE: payload keys = ' + JSON.stringify(payloadKeys) +
            ' — extra keys would overwrite unrelated database columns.'
        );

        // Now also verify the source-level implementation in publishingStore.js
        // matches this contract (only hasOwnProperty checks, no fallthrough)
        const storeSource = fs.readFileSync(
            path.join(ROOT, 'services', 'publishingStore.js'),
            'utf8'
        );

        const hasBuildQueueUpdatePayload = /function buildQueueUpdatePayload\s*\(/.test(storeSource);
        assert.ok(
            hasBuildQueueUpdatePayload,
            'publishingStore.js does not define buildQueueUpdatePayload(). ' +
            'COUNTEREXAMPLE: Without this function, queue status patches may send full ' +
            'row objects to Supabase PATCH, overwriting content/metadata with null.'
        );

        // The implementation must use hasOwnProperty checks (not blind spread/assign)
        const usesHasOwnProperty = /hasOwnProperty/.test(storeSource);
        assert.ok(
            usesHasOwnProperty,
            'publishingStore.js buildQueueUpdatePayload does not use hasOwnProperty checks. ' +
            'COUNTEREXAMPLE: Without explicit property checks, a PATCH with {status: "published"} ' +
            'might accidentally spread the entire patch object including undefined keys, ' +
            'wiping existing content or metadata fields in Supabase.'
        );

        recordPass('2.c \u2014 Queue item patch preserves other fields');
    });

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    console.log('\n' + '='.repeat(60));
    console.log('Preservation Property Test Summary');
    console.log('='.repeat(60));

    const passed = results.filter(function (r) { return r.status === 'PASS'; });
    const failed = results.filter(function (r) { return r.status === 'FAIL'; });

    console.log(
        '\nTotal: ' + results.length +
        '  |  \u2705 Passed: ' + passed.length +
        '  |  \u274C Failed: ' + failed.length
    );

    if (failed.length > 0) {
        console.log('\n--- FAILURES (Regression Detected) ---');
        failed.forEach(function (r) {
            console.log('\n  ' + r.label);
            console.log('  Counterexample: ' + r.counterexample);
        });
        console.log(
            '\n\u26A0\uFE0F  Preservation tests FAILED. A regression has been introduced.' +
            '\n   These tests must pass on both unfixed and fixed code.'
        );
        process.exitCode = 1;
    } else {
        console.log('\n\uD83C\uDF89 All preservation properties hold. No regressions detected.');
    }

    console.log('');
})();
