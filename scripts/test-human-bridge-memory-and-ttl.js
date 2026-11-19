const assert = require("assert");

const HumanBridgeCallSession = require("../src/modules/calls/human-bridge-call-session");
const {
    AudioOutput,
    clearAudioUrlPcmCache,
    _audioUrlPcmCache,
} = require("../src/modules/calls/audio-output");
const healthController = require("../src/controllers/health.controller");

async function testWaitToneBufferStaysBoundedAndUsesCachedPcm() {
    const sentFrames = [];
    const output = new AudioOutput(
        { onData: (frame) => sentFrames.push(frame) },
        { sampleRate: 48000, frameMs: 10, silenceLogEveryFrames: 0 }
    );

    const session = new HumanBridgeCallSession(
        {
            call_id: "call-bounded-wait-music",
            phone_number_id: "phone-1",
            offer_sdp: "v=0\r\n",
            wait_tone_enabled: true,
        },
        {
            sessionId: "session-bounded-wait-music",
            baseUrl: "http://localhost",
        }
    );

    session.metaAudioOutput = output;
    session.startWaitToneLoop();

    const firstLength = output.buffer.length;
    assert.ok(firstLength > 350000 && firstLength < 450000, `Unexpected first wait music buffer size: ${firstLength}`);
    assert.strictEqual(output.playbackJobs.length, 1);
    assert.ok(output.bufferedMs() >= 4000);

    // Wait 1.25s while AudioOutput is NOT draining; old code would keep stacking buffers unconditionally.
    await new Promise((resolve) => setTimeout(resolve, 1250));
    assert.strictEqual(
        output.playbackJobs.length,
        1,
        `Wait music must not stack jobs while bufferedMs (${output.bufferedMs()}) > low water mark`
    );
    assert.strictEqual(output.buffer.length, firstLength);

    // Drain down to 500ms (< 1200ms low water) and ensure next tick replenishes seamlessly
    output.buffer = output.buffer.subarray(output.buffer.length - output.frameBytes * 50);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.strictEqual(output.playbackJobs.length, 2);
    assert.ok(output.bufferedMs() >= 4500 && output.bufferedMs() <= 5500);

    session.stopWaitingPlayback("test_done");
    assert.strictEqual(session.waitToneTimer, null);
    assert.strictEqual(output.buffer.length, 0);
}

async function testAudioUrlPcmCacheHitAvoidsRefetch() {
    clearAudioUrlPcmCache();
    const logs = [];
    const output = new AudioOutput(
        { onData: () => {} },
        {
            sampleRate: 48000,
            channelCount: 1,
            frameMs: 10,
            logger: (msg, data) => logs.push({ msg, data }),
        }
    );

    const url = "https://sigcrm.pro/storage/dispositivos/wait_audios/cached-sample.mp3";
    const cacheKey = `${url}|48000|1`;
    const fakePcm = Buffer.alloc(960 * 10, 1);
    _audioUrlPcmCache.set(cacheKey, {
        pcm: fakePcm,
        bytesDownloaded: 1234,
        contentType: "audio/mpeg",
        expiresAt: Date.now() + 60000,
    });

    const promise = output.enqueueAudioUrl(url, { source: "unit_test" });
    output.clear("test_cleanup");
    const result = await promise;

    assert.strictEqual(result.cacheHit, true);
    assert.strictEqual(result.bytesDownloaded, 1234);
    assert.ok(logs.some((entry) => entry.msg === "agent audio_url cache hit"));
    clearAudioUrlPcmCache();
}

function makeSession(id) {
    const closedReasons = [];
    const session = new HumanBridgeCallSession(
        {
            call_id: `call-${id}`,
            phone_number_id: "phone-1",
            offer_sdp: "v=0\r\n",
        },
        {
            sessionId: `session-${id}`,
            baseUrl: "http://localhost",
        }
    );
    session.close = async (reason) => {
        closedReasons.push(reason);
        session.closedAt = new Date();
    };
    return { session, closedReasons };
}

async function testLifecycleWatchdogSafetyAndZombieCleanup() {
    const baseNow = Date.now();

    // 1. Live active call receiving RTP frames for 10 minutes must NEVER be closed
    {
        const { session, closedReasons } = makeSession("live-10m");
        session.createdAt = new Date(baseNow - 10 * 60 * 1000);
        session.metaFramesReceived = 30000;
        session.lastMetaFrameAt = baseNow - 500;
        const reason = session.checkLifecycle(baseNow);
        assert.strictEqual(reason, null);
        assert.strictEqual(closedReasons.length, 0);
    }

    // 2. Short 15s ICE disconnect hiccup must NOT close, and reconnect clears timer
    {
        const { session, closedReasons } = makeSession("hiccup-15s");
        session.metaFramesReceived = 500;
        session.lastMetaFrameAt = baseNow - 15000;
        session.metaDisconnectedSince = baseNow - 15000;
        assert.strictEqual(session.checkLifecycle(baseNow), null);
        session.handleIceState("meta", "connected");
        assert.strictEqual(session.metaDisconnectedSince, null);
        assert.strictEqual(closedReasons.length, 0);
    }

    // 3. Sustained 50s ICE disconnect closes zombie cleanly
    {
        const { session, closedReasons } = makeSession("disconnected-50s");
        session.metaFramesReceived = 500;
        session.lastMetaFrameAt = baseNow - 50000;
        session.metaDisconnectedSince = baseNow - 50000;
        const reason = session.checkLifecycle(baseNow);
        assert.strictEqual(reason, "meta_ice_disconnected_timeout");
        assert.deepStrictEqual(closedReasons, ["meta_ice_disconnected_timeout"]);
    }

    // 4. Dead RTP for 130s closes zombie cleanly
    {
        const { session, closedReasons } = makeSession("rtp-dead-130s");
        session.metaFramesReceived = 500;
        session.lastMetaFrameAt = baseNow - 130000;
        const reason = session.checkLifecycle(baseNow);
        assert.strictEqual(reason, "meta_media_idle_timeout");
        assert.deepStrictEqual(closedReasons, ["meta_media_idle_timeout"]);
    }

    // 5. Orphan that never connected ICE for 130s closes cleanly
    {
        const { session, closedReasons } = makeSession("orphan-130s");
        session.createdAt = new Date(baseNow - 130000);
        session.metaFramesReceived = 0;
        const reason = session.checkLifecycle(baseNow);
        assert.strictEqual(reason, "meta_connect_timeout");
        assert.deepStrictEqual(closedReasons, ["meta_connect_timeout"]);
    }

    // 6. Absolute max duration (61 minutes) closes cleanly
    {
        const { session, closedReasons } = makeSession("max-61m");
        session.createdAt = new Date(baseNow - 61 * 60 * 1000);
        session.metaFramesReceived = 180000;
        session.lastMetaFrameAt = baseNow - 100;
        const reason = session.checkLifecycle(baseNow);
        assert.strictEqual(reason, "human_bridge_max_duration");
        assert.deepStrictEqual(closedReasons, ["human_bridge_max_duration"]);
    }
}

function testHealthEndpointIncludesDiagnostics() {
    let jsonPayload = null;
    const req = {
        originalUrl: "/api/health",
        get: () => "application/json",
    };
    const res = {
        json: (payload) => {
            jsonPayload = payload;
            return payload;
        },
    };

    healthController.health(req, res);

    assert.strictEqual(jsonPayload.ok, true);
    assert.strictEqual(jsonPayload.status, "healthy");
    assert.strictEqual(typeof jsonPayload.active_sessions, "number");
    assert.strictEqual(typeof jsonPayload.memory_rss_mb, "number");
    assert.ok(jsonPayload.memory_rss_mb > 0);
    assert.strictEqual(typeof jsonPayload.uptime_seconds, "number");
}

async function run() {
    await testWaitToneBufferStaysBoundedAndUsesCachedPcm();
    await testAudioUrlPcmCacheHitAvoidsRefetch();
    await testLifecycleWatchdogSafetyAndZombieCleanup();
    testHealthEndpointIncludesDiagnostics();
    console.log("human-bridge memory & TTL tests passed");
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

