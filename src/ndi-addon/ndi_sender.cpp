/**
 * OGraf NDI Sender — Native N-API Addon
 * Coded by Murat Demirci
 *
 * NDI SDK v6 send API'sini Node.js'e bağlayan native modül.
 *   - BGRA piksel formatı (Chromium/Electron çıktısıyla uyumlu)
 *   - Ayrı gönderim thread'i + frame kuyruğu
 *   - Kendi zamanlamamız (NDI clock devre dışı)
 *
 * JS API:
 *   createSender(name, width, height, fpsN, fpsD): handle
 *   sendFrame(handle, buffer): void
 *   getConnections(handle): number
 *   getTally(handle): { onProgram, onPreview }
 *   getStats(handle): { framesSent, framesDropped, queueDepth }
 *   destroySender(handle): void
 *   version(): string
 */

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include <napi.h>
#include <Processing.NDI.Lib.h>

#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstring>
#include <string>

// ── Sender instance ─────────────────────────────────────────
struct NdiSender {
    NDIlib_send_instance_t  ndi_send = nullptr;
    int                     width    = 1920;
    int                     height   = 1080;
    int                     fps_n    = 25000;
    int                     fps_d    = 1000;
    std::string             name;

    // Gönderim thread'i + frame kuyruğu
    std::thread             send_thread;
    std::mutex              queue_mutex;
    std::condition_variable queue_cv;
    std::queue<std::vector<uint8_t>> frame_queue;
    std::atomic<bool>       running{false};

    // Stats
    std::atomic<uint64_t>   frames_sent{0};
    std::atomic<uint64_t>   frames_dropped{0};

    static constexpr int    MAX_QUEUE_SIZE  = 4;   // Max buffered frames
    static constexpr int    PREROLL_FRAMES  = 2;   // Wait for N frames before starting send loop
};

// Global sender registry
static std::vector<NdiSender*> g_senders;
static std::mutex              g_senders_mutex;
static bool                    g_ndi_initialized = false;

// ── Send thread (runs at real-time priority) ────────────────
static void send_thread_func(NdiSender* s) {
    // Set thread priority (best effort)
#ifdef _WIN32
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
#endif

    const auto frame_duration = std::chrono::microseconds(
        (int64_t)s->fps_d * 1000000LL / (int64_t)s->fps_n
    );

    // Wait for preroll buffer to fill
    {
        std::unique_lock<std::mutex> lock(s->queue_mutex);
        s->queue_cv.wait(lock, [&] {
            return !s->running || (int)s->frame_queue.size() >= NdiSender::PREROLL_FRAMES;
        });
    }

    auto next_send = std::chrono::steady_clock::now();

    while (s->running) {
        std::vector<uint8_t> frame_data;

        {
            std::unique_lock<std::mutex> lock(s->queue_mutex);
            // Wait until a frame is available or we're shutting down
            s->queue_cv.wait_for(lock, frame_duration, [&] {
                return !s->frame_queue.empty() || !s->running;
            });

            if (!s->running) break;

            if (s->frame_queue.empty()) continue;

            frame_data = std::move(s->frame_queue.front());
            s->frame_queue.pop();
        }

        // Pace to target frame rate
        auto now = std::chrono::steady_clock::now();
        if (next_send > now) {
            std::this_thread::sleep_until(next_send);
        }
        next_send = std::chrono::steady_clock::now() + frame_duration;

        // Build NDI video frame descriptor
        NDIlib_video_frame_v2_t ndi_frame;
        ndi_frame.xres                  = s->width;
        ndi_frame.yres                  = s->height;
        ndi_frame.FourCC                = NDIlib_FourCC_video_type_BGRA;
        ndi_frame.frame_rate_N          = s->fps_n;
        ndi_frame.frame_rate_D          = s->fps_d;
        ndi_frame.picture_aspect_ratio  = (float)s->width / (float)s->height;
        ndi_frame.frame_format_type     = NDIlib_frame_format_type_progressive;
        ndi_frame.timecode              = NDIlib_send_timecode_synthesize;
        ndi_frame.p_data                = frame_data.data();
        ndi_frame.line_stride_in_bytes  = s->width * 4;
        ndi_frame.p_metadata            = nullptr;
        ndi_frame.timestamp             = 0;

        // Send (synchronous — blocks until NDI is done with the buffer)
        NDIlib_send_send_video_v2(s->ndi_send, &ndi_frame);
        s->frames_sent++;
    }
}

// ── N-API: createSender ─────────────────────────────────────
static Napi::Value CreateSender(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 5) {
        Napi::TypeError::New(env, "createSender(name, width, height, fpsN, fpsD)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    // Initialize NDI on first use
    if (!g_ndi_initialized) {
        if (!NDIlib_initialize()) {
            Napi::Error::New(env, "NDIlib_initialize() failed — NDI Runtime not installed?")
                .ThrowAsJavaScriptException();
            return env.Null();
        }
        g_ndi_initialized = true;
    }

    auto* s   = new NdiSender();
    s->name   = info[0].As<Napi::String>().Utf8Value();
    s->width  = info[1].As<Napi::Number>().Int32Value();
    s->height = info[2].As<Napi::Number>().Int32Value();
    s->fps_n  = info[3].As<Napi::Number>().Int32Value();
    s->fps_d  = info[4].As<Napi::Number>().Int32Value();

    // NDI sender oluştur — clock devre dışı (zamanlamayı biz yönetiyoruz)
    // DIPNOT: NDI clock'u kapatıyoruz çünkü frame timing'i Electron paint event
    // tarafından belirleniyor. NDI clock açılırsa sender kendi hızında çeker ve
    // frame timing tutarsızlığı olur. İleride genlock/referans sinyali eklenirse
    // bu yaklaşım yeniden değerlendirilmeli.
    NDIlib_send_create_t create_desc;
    create_desc.p_ndi_name  = s->name.c_str();
    create_desc.p_groups    = nullptr;
    create_desc.clock_video = false;
    create_desc.clock_audio = false;

    s->ndi_send = NDIlib_send_create(&create_desc);
    if (!s->ndi_send) {
        delete s;
        Napi::Error::New(env, "NDIlib_send_create() failed")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    // Start send thread
    s->running = true;
    s->send_thread = std::thread(send_thread_func, s);

    // Register and return handle
    std::lock_guard<std::mutex> lock(g_senders_mutex);
    int handle = (int)g_senders.size();
    g_senders.push_back(s);

    return Napi::Number::New(env, handle);
}

// ── N-API: sendFrame ────────────────────────────────────────
static Napi::Value SendFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "sendFrame(handle, buffer)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    int handle = info[0].As<Napi::Number>().Int32Value();

    std::lock_guard<std::mutex> g_lock(g_senders_mutex);
    if (handle < 0 || handle >= (int)g_senders.size() || !g_senders[handle]) {
        Napi::Error::New(env, "Invalid sender handle")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* s = g_senders[handle];
    if (!s->running) return env.Undefined();

    // Get frame buffer
    auto buf = info[1].As<Napi::Buffer<uint8_t>>();
    size_t expected = (size_t)s->width * s->height * 4;

    if (buf.Length() != expected) {
        Napi::Error::New(env,
            "Buffer size mismatch: got " + std::to_string(buf.Length()) +
            ", expected " + std::to_string(expected))
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    // JS buffer'dan kopyala (GC'nin buffer'ı silmesini önle)
    // DIPNOT: Her frame'de ~8MB kopyalama yapıyoruz — bu maliyetli.
    // İleride: (1) SharedArrayBuffer ile zero-copy, (2) ring buffer ile
    // önceden ayrılmış bellek havuzu, veya (3) Napi::Reference ile
    // buffer'ı pinleyip kopyalamadan kullanmak denenebilir.
    std::vector<uint8_t> frame_copy(expected);
    std::memcpy(frame_copy.data(), buf.Data(), expected);

    {
        std::lock_guard<std::mutex> lock(s->queue_mutex);

        // Drop oldest frame if queue is full (prefer freshness over latency)
        if ((int)s->frame_queue.size() >= NdiSender::MAX_QUEUE_SIZE) {
            s->frame_queue.pop();
            s->frames_dropped++;
        }

        s->frame_queue.push(std::move(frame_copy));
    }
    s->queue_cv.notify_one();

    return env.Undefined();
}

// ── N-API: getConnections ───────────────────────────────────
static Napi::Value GetConnections(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();

    std::lock_guard<std::mutex> lock(g_senders_mutex);
    if (handle < 0 || handle >= (int)g_senders.size() || !g_senders[handle])
        return Napi::Number::New(env, 0);

    return Napi::Number::New(env,
        NDIlib_send_get_no_connections(g_senders[handle]->ndi_send, 0));
}

// ── N-API: getTally ─────────────────────────────────────────
static Napi::Value GetTally(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();

    std::lock_guard<std::mutex> lock(g_senders_mutex);
    if (handle < 0 || handle >= (int)g_senders.size() || !g_senders[handle]) {
        auto obj = Napi::Object::New(env);
        obj.Set("onProgram", false);
        obj.Set("onPreview", false);
        return obj;
    }

    NDIlib_tally_t tally;
    NDIlib_send_get_tally(g_senders[handle]->ndi_send, &tally, 0);

    auto obj = Napi::Object::New(env);
    obj.Set("onProgram", tally.on_program);
    obj.Set("onPreview", tally.on_preview);
    return obj;
}

// ── N-API: getStats ─────────────────────────────────────────
static Napi::Value GetStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();

    std::lock_guard<std::mutex> lock(g_senders_mutex);
    if (handle < 0 || handle >= (int)g_senders.size() || !g_senders[handle]) {
        auto obj = Napi::Object::New(env);
        obj.Set("framesSent", (double)0);
        obj.Set("framesDropped", (double)0);
        obj.Set("queueDepth", 0);
        return obj;
    }

    auto* s = g_senders[handle];
    auto obj = Napi::Object::New(env);
    obj.Set("framesSent", (double)s->frames_sent.load());
    obj.Set("framesDropped", (double)s->frames_dropped.load());

    {
        std::lock_guard<std::mutex> q_lock(s->queue_mutex);
        obj.Set("queueDepth", (int)s->frame_queue.size());
    }

    return obj;
}

// ── N-API: destroySender ────────────────────────────────────
static Napi::Value DestroySender(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();

    NdiSender* s = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_senders_mutex);
        if (handle < 0 || handle >= (int)g_senders.size() || !g_senders[handle])
            return env.Undefined();
        s = g_senders[handle];
        g_senders[handle] = nullptr;
    }

    // Stop send thread
    s->running = false;
    s->queue_cv.notify_all();
    if (s->send_thread.joinable())
        s->send_thread.join();

    // Destroy NDI sender
    if (s->ndi_send) {
        // Flush any async frame
        NDIlib_send_send_video_async_v2(s->ndi_send, nullptr);
        NDIlib_send_destroy(s->ndi_send);
    }

    delete s;
    return env.Undefined();
}

// ── N-API: version ──────────────────────────────────────────
static Napi::Value GetVersion(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_ndi_initialized) {
        if (!NDIlib_initialize()) {
            return Napi::String::New(env, "NDI not available");
        }
        g_ndi_initialized = true;
    }
    return Napi::String::New(env, NDIlib_version());
}

// ── Module init ─────────────────────────────────────────────
using NapiFn = Napi::Value(*)(const Napi::CallbackInfo&);

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("createSender",   Napi::Function::New(env, (NapiFn)CreateSender,   "createSender"));
    exports.Set("sendFrame",      Napi::Function::New(env, (NapiFn)SendFrame,      "sendFrame"));
    exports.Set("getConnections", Napi::Function::New(env, (NapiFn)GetConnections, "getConnections"));
    exports.Set("getTally",       Napi::Function::New(env, (NapiFn)GetTally,       "getTally"));
    exports.Set("getStats",       Napi::Function::New(env, (NapiFn)GetStats,       "getStats"));
    exports.Set("destroySender",  Napi::Function::New(env, (NapiFn)DestroySender,  "destroySender"));
    exports.Set("version",        Napi::Function::New(env, (NapiFn)GetVersion,     "version"));
    return exports;
}

NODE_API_MODULE(ograf_ndi, Init)
