/**
 * Bug Condition Exploration Tests
 * PostCraft AI — LinkedIn Auth & Storage Fix
 *
 * PURPOSE: Each test encodes the EXPECTED (correct) behavior for a specific bug condition.
 *
 * ON UNFIXED CODE: These tests would FAIL, proving the bugs exist.
 * ON FIXED CODE:   These tests PASS, confirming all six bugs are resolved.
 *
 * Runnable with: node tests/bug-exploration.test.js
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
// Main test runner (async IIFE — required for CommonJS top-level await)
// ---------------------------------------------------------------------------
(async () => {
    // -----------------------------------------------------------------------
    // Test 1.a — OAuth Callback Crash
    //
    // BUG: upsertLinkedInOAuthAccount() called ensureSupabaseProfile() which
    //      tried to upsert into public.profiles — a table that does not exist.
    //      With Supabase configured, every LinkedIn OAuth callback threw:
    //        "Supabase profile setup failed: relation "public.profiles" does not exist"
    //
    // FIX: Remove ensureSupabaseProfile(). Use { localOnly: true } so the
    //      Express path always writes to local JSON, bypassing Supabase.
    //
    // TEST: Read index.js source and assert ensureSupabaseProfile is NOT
    //       called and that { localOnly: true } is used instead.
    // -----------------------------------------------------------------------
    await runTest('1.a \u2014 OAuth Callback Crash', function () {
        var indexSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

        // On UNFIXED code: ensureSupabaseProfile appears as a call inside the function
        var hasEnsureSupabaseProfileCall = /ensureSupabaseProfile\s*\(/.test(indexSource);

        assert.strictEqual(
            hasEnsureSupabaseProfileCall,
            false,
            'ensureSupabaseProfile() is still called inside upsertLinkedInOAuthAccount — ' +
            'this causes a 500 crash when public.profiles does not exist in Supabase. ' +
            'COUNTEREXAMPLE: calling upsertLinkedInOAuthAccount with a valid profile throws ' +
            '"Supabase profile setup failed: relation \\"public.profiles\\" does not exist"'
        );

        // The function must use { localOnly: true } context
        var fnStart = indexSource.indexOf('async function upsertLinkedInOAuthAccount');
        var fnEnd = indexSource.indexOf('\n// Middleware', fnStart);
        var fnBody = fnStart !== -1 && fnEnd !== -1
            ? indexSource.slice(fnStart, fnEnd)
            : indexSource;

        var usesLocalOnly = /localOnly\s*:\s*true/.test(fnBody);
        assert.strictEqual(
            usesLocalOnly,
            true,
            'upsertLinkedInOAuthAccount does not use { localOnly: true } — ' +
            'Supabase writes in the OAuth hot path will fail when tables are absent. ' +
            'COUNTEREXAMPLE: without localOnly, the function attempts readSupabaseState ' +
            'and crashes with a Supabase 404/500 error on every OAuth callback.'
        );

        recordPass('1.a \u2014 OAuth Callback Crash');
    });

    // -----------------------------------------------------------------------
    // Test 1.b — Route Interception
    //
    // Historically covered netlify.toml redirect ordering. The project no
    // longer deploys through Netlify Functions (see index.js for the local
    // Express routes), so this check no longer applies and was removed.
    // -----------------------------------------------------------------------


    // -----------------------------------------------------------------------
    // Test 1.c — Email Corruption
    //
    // BUG: publisher.html contained a sanitizeEmail() function that replaced
    //      the domain of any non-LinkedIn email with "@linkedin.com":
    //        sanitizeEmail("user@gmail.com") → "user@linkedin.com"
    //
    // FIX: Delete sanitizeEmail() entirely and all its call sites.
    //
    // TEST: Read publisher.html source. If sanitizeEmail is absent → PASS.
    //       If it is present, evaluate it and assert the output is unchanged.
    // -----------------------------------------------------------------------
    await runTest('1.c \u2014 Email Corruption', function () {
        var publisherSource = fs.readFileSync(
            path.join(ROOT, 'public', 'publisher.html'),
            'utf8'
        );

        // Extract the sanitizeEmail function if it exists
        var fnMatch = publisherSource.match(
            /function\s+sanitizeEmail\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/
        );

        if (!fnMatch) {
            // Function has been removed — this is the correct fix
            recordPass('1.c \u2014 Email Corruption');
            return;
        }

        // Function still exists — run it to see if it corrupts Gmail addresses
        var fnSource = 'function sanitizeEmail(email) {' + fnMatch[1] + '\n}';
        var sanitizeEmail;
        try {
            // eslint-disable-next-line no-new-func
            sanitizeEmail = new Function(fnSource + '; return sanitizeEmail;')();
        } catch (evalErr) {
            recordFail('1.c \u2014 Email Corruption', 'Could not evaluate sanitizeEmail: ' + evalErr.message);
            return;
        }

        var input = 'user@gmail.com';
        var output = sanitizeEmail(input);

        assert.strictEqual(
            output,
            input,
            'sanitizeEmail("user@gmail.com") returned "' + output + '" instead of "' + input + '". ' +
            'COUNTEREXAMPLE: sanitizeEmail corrupts Gmail addresses by replacing ' +
            '@gmail.com with @linkedin.com, showing the wrong email address in the UI.'
        );

        recordPass('1.c \u2014 Email Corruption');
    });

    // -----------------------------------------------------------------------
    // Test 1.d — Schema FK Constraint
    //
    // BUG: supabase-schema.sql defined user_id as:
    //        user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
    //      Inserting a row with a derived UUID (not in auth.users) raised FK
    //      error 23503. Also, the schema included a public.profiles table that
    //      caused "relation does not exist" errors on every OAuth callback.
    //
    // FIX: Change user_id to nullable TEXT with no FK on accounts, schedules,
    //      and queue_items. Remove public.profiles. Disable RLS on all tables.
    //
    // TEST: Parse supabase-schema.sql and assert no table has the buggy FK.
    // -----------------------------------------------------------------------
    await runTest('1.d \u2014 Schema FK Constraint', function () {
        var schemaSource = fs.readFileSync(path.join(ROOT, 'supabase-schema.sql'), 'utf8');
        var tables = ['accounts', 'schedules', 'queue_items'];

        tables.forEach(function (table) {
            var tableStart = schemaSource.indexOf('create table if not exists public.' + table);
            if (tableStart === -1) {
                return; // Table block not found — skip
            }
            var tableEnd = schemaSource.indexOf(');', tableStart);
            var tableBlock = schemaSource.slice(tableStart, tableEnd + 2);

            // Check for the buggy pattern: uuid NOT NULL REFERENCES auth.users
            var hasFKToAuthUsers = /user_id\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+auth\.users/i
                .test(tableBlock);

            assert.strictEqual(
                hasFKToAuthUsers,
                false,
                'Table "' + table + '" still has user_id uuid NOT NULL REFERENCES auth.users. ' +
                'COUNTEREXAMPLE: INSERT into ' + table + ' with user_id derived from LinkedIn memberId ' +
                'raises FK violation error 23503 because the UUID is not present in auth.users. ' +
                'FIX: Change to user_id text (nullable, no FK).'
            );

            // Assert user_id is defined as text (nullable)
            var hasNullableText = /user_id\s+text[\s,;-]/.test(tableBlock);
            assert.ok(
                hasNullableText,
                'Table "' + table + '" does not define user_id as nullable text. ' +
                'COUNTEREXAMPLE: A non-text or NOT NULL user_id column will reject ' +
                'inserts with null or non-UUID user identifiers.'
            );
        });

        // Assert public.profiles table is NOT present (it caused "relation does not exist")
        var hasProfilesTable = /create\s+table\s+.*public\.profiles/i.test(schemaSource);
        assert.strictEqual(
            hasProfilesTable,
            false,
            'supabase-schema.sql still defines public.profiles table. ' +
            'COUNTEREXAMPLE: ensureSupabaseProfile() upserts to public.profiles which ' +
            'does not exist in the deployed schema, raising ' +
            '"relation \\"public.profiles\\" does not exist" on every OAuth callback.'
        );

        // Assert RLS is disabled on all three tables
        tables.forEach(function (table) {
            var hasRlsDisabled = new RegExp(
                'alter\\s+table\\s+public\\.' + table + '\\s+disable\\s+row\\s+level\\s+security',
                'i'
            ).test(schemaSource);

            assert.ok(
                hasRlsDisabled,
                'Table "' + table + '" does not have DISABLE ROW LEVEL SECURITY. ' +
                'COUNTEREXAMPLE: Without disabling RLS, the service-role key ' +
                'cannot read/write rows when no Auth session exists, ' +
                'causing 0-row results on all Supabase queries.'
            );
        });

        recordPass('1.d \u2014 Schema FK Constraint');
    });

    // -----------------------------------------------------------------------
    // Test 1.e — Storage Fallback
    //
    // BUG: readState() in publishingStore.js had no try/catch around the
    //      Supabase call. When SUPABASE_URL was set but tables were absent,
    //      the axios error propagated as an unhandled 500 to every API caller.
    //
    // FIX: Wrap readSupabaseState() in try/catch; on error, log a warning
    //      and fall back to readLocalState().
    //
    // TEST: Read publishingStore.js source and assert readState() has a
    //       try/catch that falls back to readLocalState on Supabase failure.
    // -----------------------------------------------------------------------
    await runTest('1.e \u2014 Storage Fallback', function () {
        var storeSource = fs.readFileSync(
            path.join(ROOT, 'services', 'publishingStore.js'),
            'utf8'
        );

        // Extract the readState function body
        var readStateStart = storeSource.indexOf('async function readState(');
        var readStateEnd = storeSource.indexOf('\nasync function writeState(', readStateStart);
        var readStateFn = readStateStart !== -1 && readStateEnd !== -1
            ? storeSource.slice(readStateStart, readStateEnd)
            : storeSource;

        // Must have a try block
        var hasTryBlock = /try\s*\{/.test(readStateFn);
        assert.ok(
            hasTryBlock,
            'readState() has no try/catch block. ' +
            'COUNTEREXAMPLE: When Supabase is configured but tables are absent, ' +
            'readState() throws a Supabase 404 error instead of falling back to ' +
            'local storage, propagating a 500 to every API caller ' +
            '(GET /publishing/overview, POST /publishing/schedules, etc.).'
        );

        // The catch block must call readLocalState as the fallback
        var hasCatchWithFallback = /catch\s*\([\s\S]{0,40}\)\s*\{[\s\S]*?readLocalState/.test(readStateFn);
        assert.ok(
            hasCatchWithFallback,
            'readState() catch block does not call readLocalState(). ' +
            'COUNTEREXAMPLE: The catch block exists but does not fall back to local storage ' +
            '— Supabase errors still propagate to callers as unhandled exceptions.'
        );

        recordPass('1.e \u2014 Storage Fallback');
    });

    // -----------------------------------------------------------------------
    // Test 1.f — Scheduler Context
    //
    // BUG: publishQueueItem() used the raw caller context {} for all storage
    //      calls. When context = {} and Supabase is enabled, buildUserFilterParams
    //      calls requireUserId({}) which throws "Authenticated user context is
    //      required." (401), so state reads return 0 items and nothing publishes.
    //
    // FIX: Compute effectiveContext at the top of publishQueueItem:
    //        if no scope AND no userId → { scope: 'all' }
    //        otherwise use context as-is.
    //
    // TEST: Read schedulerService.js source and assert publishQueueItem
    //       computes an effectiveContext that normalizes {} to { scope: 'all' }.
    // -----------------------------------------------------------------------
    await runTest('1.f \u2014 Scheduler Context', function () {
        var schedulerSource = fs.readFileSync(
            path.join(ROOT, 'services', 'schedulerService.js'),
            'utf8'
        );

        // Extract the publishQueueItem function body
        var fnStart = schedulerSource.indexOf('async function publishQueueItem(');
        var fnEnd = schedulerSource.indexOf('\nasync function publishDueQueueItems(', fnStart);
        var fnBody = fnStart !== -1 && fnEnd !== -1
            ? schedulerSource.slice(fnStart, fnEnd)
            : schedulerSource;

        // Must compute an effectiveContext (not use raw context for all storage calls)
        var hasEffectiveContext = /effectiveContext/.test(fnBody);
        assert.ok(
            hasEffectiveContext,
            'publishQueueItem() does not compute an effectiveContext. ' +
            'COUNTEREXAMPLE: Called with context={}, it passes {} directly to readState(). ' +
            'When Supabase is enabled, buildUserFilterParams({}) calls requireUserId({}) ' +
            'which throws "Authenticated user context is required." (401), ' +
            'so the queue item is never found and nothing is published.'
        );

        // The effectiveContext must normalize {} to { scope: 'all' }
        // Look for the pattern: scope === 'all' OR localOnly OR userId check → scope:'all'
        var normalizesToScopeAll = /scope\s*:\s*['"]all['"]/.test(fnBody);
        assert.ok(
            normalizesToScopeAll,
            'publishQueueItem() effectiveContext does not normalize empty context to { scope: "all" }. ' +
            'COUNTEREXAMPLE: When Express calls publishQueueItem(id) with no context arg (defaults to {}), ' +
            'the storage read is scoped to an undefined userId and returns 0 items. ' +
            'The queue item is silently not found, so nothing is published.'
        );

        // The effectiveContext must actually be used for readState (not the raw context)
        var usesEffectiveContextForRead = /readState\s*\(\s*effectiveContext\s*\)/.test(fnBody);
        assert.ok(
            usesEffectiveContextForRead,
            'publishQueueItem() calls readState(context) instead of readState(effectiveContext). ' +
            'COUNTEREXAMPLE: Even if effectiveContext is computed, using raw context for readState ' +
            'means the normalization has no effect — the bug still persists for empty context callers.'
        );

        recordPass('1.f \u2014 Scheduler Context');
    });

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    console.log('\n' + '='.repeat(60));
    console.log('Bug Condition Exploration Test Summary');
    console.log('='.repeat(60));

    var passed = results.filter(function (r) { return r.status === 'PASS'; });
    var failed = results.filter(function (r) { return r.status === 'FAIL'; });

    console.log(
        '\nTotal: ' + results.length +
        '  |  \u2705 Passed: ' + passed.length +
        '  |  \u274C Failed: ' + failed.length
    );

    if (failed.length > 0) {
        console.log('\n--- FAILURES (Bug Conditions Still Present) ---');
        failed.forEach(function (r) {
            console.log('\n  ' + r.label);
            console.log('  Counterexample: ' + r.counterexample);
        });
        console.log('\n\u26A0\uFE0F  EXPECTED on UNFIXED code. Failures prove the bugs exist.');
        console.log('   Once the fix is applied, all tests should PASS.');
        process.exitCode = 1;
    } else {
        console.log('\n\uD83C\uDF89 All bug conditions are resolved. The fixes are in place.');
    }

    console.log('');
})();
