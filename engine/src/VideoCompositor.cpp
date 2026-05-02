#include "VideoCompositor.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>

// ── Shader sources (single-layer, legacy) ───────────────────────────────────

static const char* kVertexShaderSrc = R"glsl(
#version 330 core
layout (location = 0) in vec2 aPos;
layout (location = 1) in vec2 aTexCoord;
out vec2 TexCoord;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
    TexCoord = aTexCoord;
}
)glsl";

static const char* kFragmentShaderSrc = R"glsl(
#version 330 core
in vec2 TexCoord;
out vec4 FragColor;
uniform sampler2D yTex;
uniform sampler2D uTex;
uniform sampler2D vTex;
void main() {
    float y = texture(yTex, TexCoord).r;
    float u = texture(uTex, TexCoord).r - 0.5;
    float v = texture(vTex, TexCoord).r - 0.5;
    float r = y + 1.5748 * v;
    float g = y - 0.1873 * u - 0.4681 * v;
    float b = y + 1.8556 * u;
    FragColor = vec4(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), 1.0);
}
)glsl";

// ── Composite shader sources ────────────────────────────────────────────────

static const char* kCompositeVertexSrc = R"glsl(
#version 330 core
layout (location = 0) in vec2 aPos;
layout (location = 1) in vec2 aTexCoord;
out vec2 TexCoord;
uniform vec2 uPosition;  // Center position (-1 to 1)
uniform vec2 uScale;     // Size (0 to 1 = fraction of screen)
void main() {
    vec2 pos = aPos * uScale + uPosition;
    gl_Position = vec4(pos, 0.0, 1.0);
    TexCoord = aTexCoord;
}
)glsl";

static const char* kCompositeFragmentSrc = R"glsl(
#version 330 core
in vec2 TexCoord;
out vec4 FragColor;
uniform sampler2D yTex;
uniform sampler2D uTex;
uniform sampler2D vTex;
uniform float uOpacity;
void main() {
    float y = texture(yTex, TexCoord).r;
    float u = texture(uTex, TexCoord).r - 0.5;
    float v = texture(vTex, TexCoord).r - 0.5;
    float r = clamp(y + 1.5748 * v, 0.0, 1.0);
    float g = clamp(y - 0.1873 * u - 0.4681 * v, 0.0, 1.0);
    float b = clamp(y + 1.8556 * u, 0.0, 1.0);
    FragColor = vec4(r, g, b, uOpacity);
}
)glsl";

// ── Fullscreen quad vertices: pos(x,y) + texcoord(u,v) ─────────────────────
// Texcoord V is flipped so video top-left maps to OpenGL bottom-left.
static const float kQuadVertices[] = {
    // pos        texcoord
    -1.0f, -1.0f,  0.0f, 1.0f,  // bottom-left  -> video top-left
     1.0f, -1.0f,  1.0f, 1.0f,  // bottom-right -> video top-right
     1.0f,  1.0f,  1.0f, 0.0f,  // top-right    -> video bottom-right
    -1.0f, -1.0f,  0.0f, 1.0f,  // bottom-left  (second triangle)
     1.0f,  1.0f,  1.0f, 0.0f,  // top-right
    -1.0f,  1.0f,  0.0f, 0.0f,  // top-left     -> video bottom-left
};

// ── Helpers ─────────────────────────────────────────────────────────────────

static void glfwErrorCallback(int error, const char* description)
{
    std::cerr << "[GLFW Error " << error << "] " << description << "\n";
}

bool VideoCompositor::checkGLError(const char* context)
{
    GLenum err = glGetError();
    if (err != GL_NO_ERROR)
    {
        std::cerr << "[GL Error] " << context << ": 0x" << std::hex << err << std::dec << "\n";
        return true;
    }
    return false;
}

GLuint VideoCompositor::makeYuvTexture(int w, int h)
{
    GLuint tex;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, w, h, 0, GL_RED, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return tex;
}

// ── Constructor / Destructor ────────────────────────────────────────────────

VideoCompositor::VideoCompositor() = default;

VideoCompositor::~VideoCompositor()
{
    shutdown();
}

// ── Initialize ──────────────────────────────────────────────────────────────

bool VideoCompositor::initialize(int windowWidth, int windowHeight, const std::string& title)
{
    glfwSetErrorCallback(glfwErrorCallback);

    if (!glfwInit())
    {
        std::cerr << "[VideoCompositor] Failed to initialize GLFW\n";
        return false;
    }

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);

    window_ = glfwCreateWindow(windowWidth, windowHeight, title.c_str(), nullptr, nullptr);
    if (!window_)
    {
        std::cerr << "[VideoCompositor] Failed to create GLFW window\n";
        glfwTerminate();
        return false;
    }

    glfwMakeContextCurrent(window_);
    glfwSwapInterval(1); // vsync

    // Initialize GLEW
    glewExperimental = GL_TRUE;
    GLenum glewErr = glewInit();
    if (glewErr != GLEW_OK)
    {
        std::cerr << "[VideoCompositor] GLEW init failed: "
                  << glewGetErrorString(glewErr) << "\n";
        glfwDestroyWindow(window_);
        window_ = nullptr;
        glfwTerminate();
        return false;
    }
    // GLEW can generate a spurious GL_INVALID_ENUM on core profile — clear it
    glGetError();

    // AMD drivers enforce GL_UNPACK_ALIGNMENT strictly; NVIDIA silently tolerates
    // misalignment. Set alignment=1 globally so R8 planes with any stride are
    // uploaded correctly on all vendors.
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);

    {
        const GLubyte* glVendor   = glGetString(GL_VENDOR);
        const GLubyte* glRenderer = glGetString(GL_RENDERER);
        const GLubyte* glVersion  = glGetString(GL_VERSION);
        const GLubyte* glslVer    = glGetString(GL_SHADING_LANGUAGE_VERSION);
        std::cout << "[VideoCompositor] OpenGL "
                  << (glVersion  ? reinterpret_cast<const char*>(glVersion)  : "(null)")
                  << " — vendor=" << (glVendor   ? reinterpret_cast<const char*>(glVendor)   : "(null)")
                  << " renderer=" << (glRenderer ? reinterpret_cast<const char*>(glRenderer) : "(null)")
                  << " glsl=" << (glslVer ? reinterpret_cast<const char*>(glslVer) : "(null)")
                  << "\n";

        // Log critical extensions and pixel-store state for AMD vs NVIDIA divergence diagnosis
        GLint unpackAlign = 0, packAlign = 0;
        glGetIntegerv(GL_UNPACK_ALIGNMENT, &unpackAlign);
        glGetIntegerv(GL_PACK_ALIGNMENT,   &packAlign);
        const bool hasPbo = GLEW_ARB_pixel_buffer_object || GLEW_VERSION_2_1;
        std::cout << "[VideoCompositor] pixel store: unpackAlign=" << unpackAlign
                  << " packAlign=" << packAlign
                  << " ARB_pixel_buffer_object=" << (hasPbo ? "yes" : "no")
                  << "\n";
    }

    if (!createShaders())          return false;
    if (!createCompositeShader())  return false;
    if (!createQuad())             return false;

    checkGLError("initialize");
    return true;
}

// ── Shutdown ────────────────────────────────────────────────────────────────

void VideoCompositor::shutdown()
{
    if (window_)
    {
        glfwMakeContextCurrent(window_);

        if (pbo_[0]) { glDeleteBuffers(2, pbo_); pbo_[0] = pbo_[1] = 0; }
        if (yTexture_) { glDeleteTextures(1, &yTexture_); yTexture_ = 0; }
        if (uTexture_) { glDeleteTextures(1, &uTexture_); uTexture_ = 0; }
        if (vTexture_) { glDeleteTextures(1, &vTexture_); vTexture_ = 0; }
        if (shaderProgram_) { glDeleteProgram(shaderProgram_); shaderProgram_ = 0; }
        if (compositeShaderProgram_) { glDeleteProgram(compositeShaderProgram_); compositeShaderProgram_ = 0; }
        if (vbo_) { glDeleteBuffers(1, &vbo_); vbo_ = 0; }
        if (vao_) { glDeleteVertexArrays(1, &vao_); vao_ = 0; }

        // Clean up multi-layer texture sets
        for (auto& ts : textureSets_)
        {
            if (ts.yTex) glDeleteTextures(1, &ts.yTex);
            if (ts.uTex) glDeleteTextures(1, &ts.uTex);
            if (ts.vTex) glDeleteTextures(1, &ts.vTex);
        }
        textureSets_.clear();
        layers_.clear();
        activeLayerCount_ = 0;

        glfwDestroyWindow(window_);
        window_ = nullptr;
        glfwTerminate();
    }

    frameWidth_ = frameHeight_ = 0;
    hasFrame_ = false;
}

// ── Shader compilation helper ───────────────────────────────────────────────

static GLuint compileShader(GLenum type, const char* src)
{
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &src, nullptr);
    glCompileShader(shader);

    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok)
    {
        char log[512];
        glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
        std::cerr << "[Shader] Compile error: " << log << "\n";
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

static GLuint linkProgram(GLuint vs, GLuint fs)
{
    GLuint program = glCreateProgram();
    glAttachShader(program, vs);
    glAttachShader(program, fs);
    glLinkProgram(program);

    GLint ok = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &ok);
    if (!ok)
    {
        char log[512];
        glGetProgramInfoLog(program, sizeof(log), nullptr, log);
        std::cerr << "[Shader] Link error: " << log << "\n";
        glDeleteProgram(program);
        return 0;
    }
    return program;
}

// ── Single-layer shader ────────────────────────────────────────────────────

bool VideoCompositor::createShaders()
{
    GLuint vs = compileShader(GL_VERTEX_SHADER, kVertexShaderSrc);
    GLuint fs = compileShader(GL_FRAGMENT_SHADER, kFragmentShaderSrc);
    if (!vs || !fs) return false;

    shaderProgram_ = linkProgram(vs, fs);
    glDeleteShader(vs);
    glDeleteShader(fs);
    if (!shaderProgram_) return false;

    glUseProgram(shaderProgram_);
    glUniform1i(glGetUniformLocation(shaderProgram_, "yTex"), 0);
    glUniform1i(glGetUniformLocation(shaderProgram_, "uTex"), 1);
    glUniform1i(glGetUniformLocation(shaderProgram_, "vTex"), 2);
    glUseProgram(0);

    checkGLError("createShaders");
    return true;
}

// ── Composite shader ───────────────────────────────────────────────────────

bool VideoCompositor::createCompositeShader()
{
    GLuint vs = compileShader(GL_VERTEX_SHADER, kCompositeVertexSrc);
    GLuint fs = compileShader(GL_FRAGMENT_SHADER, kCompositeFragmentSrc);
    if (!vs || !fs) return false;

    compositeShaderProgram_ = linkProgram(vs, fs);
    glDeleteShader(vs);
    glDeleteShader(fs);
    if (!compositeShaderProgram_) return false;

    glUseProgram(compositeShaderProgram_);
    glUniform1i(glGetUniformLocation(compositeShaderProgram_, "yTex"), 0);
    glUniform1i(glGetUniformLocation(compositeShaderProgram_, "uTex"), 1);
    glUniform1i(glGetUniformLocation(compositeShaderProgram_, "vTex"), 2);
    glUseProgram(0);

    checkGLError("createCompositeShader");
    return true;
}

// ── Fullscreen quad ─────────────────────────────────────────────────────────

bool VideoCompositor::createQuad()
{
    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &vbo_);

    glBindVertexArray(vao_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(kQuadVertices), kQuadVertices, GL_STATIC_DRAW);

    // position: location 0, 2 floats
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), (void*)0);

    // texcoord: location 1, 2 floats
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), (void*)(2 * sizeof(float)));

    glBindVertexArray(0);

    checkGLError("createQuad");
    return true;
}

// ── Legacy single-layer texture creation ────────────────────────────────────

bool VideoCompositor::createTextures(int width, int height)
{
    if (yTexture_) glDeleteTextures(1, &yTexture_);
    if (uTexture_) glDeleteTextures(1, &uTexture_);
    if (vTexture_) glDeleteTextures(1, &vTexture_);

    yTexture_ = makeYuvTexture(width, height);
    uTexture_ = makeYuvTexture(width / 2, height / 2);
    vTexture_ = makeYuvTexture(width / 2, height / 2);

    checkGLError("createTextures");
    return true;
}

// ── PBO creation ────────────────────────────────────────────────────────────

bool VideoCompositor::createPBOs(int width, int height)
{
    if (pbo_[0]) glDeleteBuffers(2, pbo_);

    size_t ySize = static_cast<size_t>(width) * height;
    size_t uvSize = static_cast<size_t>(width / 2) * (height / 2);
    size_t totalSize = ySize + 2 * uvSize;

    glGenBuffers(2, pbo_);
    for (int i = 0; i < 2; ++i)
    {
        glBindBuffer(GL_PIXEL_UNPACK_BUFFER, pbo_[i]);
        glBufferData(GL_PIXEL_UNPACK_BUFFER, static_cast<GLsizeiptr>(totalSize),
                     nullptr, GL_STREAM_DRAW);
    }
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);

    currentPBO_ = 0;
    checkGLError("createPBOs");
    return true;
}

// ── Legacy single-layer frame upload with PBO double-buffering ──────────────

void VideoCompositor::uploadFrame(const uint8_t* yPlane, const uint8_t* uPlane,
                                  const uint8_t* vPlane,
                                  int width, int height,
                                  int yStride, int uStride, int vStride)
{
    auto t0 = std::chrono::high_resolution_clock::now();

    if (width != frameWidth_ || height != frameHeight_)
    {
        frameWidth_ = width;
        frameHeight_ = height;
        createTextures(width, height);
        createPBOs(width, height);
    }

    size_t ySize  = static_cast<size_t>(width) * height;
    size_t uvW    = width / 2;
    size_t uvH    = height / 2;
    size_t uvSize = uvW * uvH;

    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, pbo_[currentPBO_]);

    uint8_t* mapped = static_cast<uint8_t*>(
        glMapBuffer(GL_PIXEL_UNPACK_BUFFER, GL_WRITE_ONLY));

    if (mapped)
    {
        if (yStride == width)
        {
            std::memcpy(mapped, yPlane, ySize);
        }
        else
        {
            for (int row = 0; row < height; ++row)
                std::memcpy(mapped + row * width, yPlane + row * yStride, width);
        }

        uint8_t* uDst = mapped + ySize;
        if (uStride == static_cast<int>(uvW))
        {
            std::memcpy(uDst, uPlane, uvSize);
        }
        else
        {
            for (size_t row = 0; row < uvH; ++row)
                std::memcpy(uDst + row * uvW, uPlane + row * uStride, uvW);
        }

        uint8_t* vDst = mapped + ySize + uvSize;
        if (vStride == static_cast<int>(uvW))
        {
            std::memcpy(vDst, vPlane, uvSize);
        }
        else
        {
            for (size_t row = 0; row < uvH; ++row)
                std::memcpy(vDst + row * uvW, vPlane + row * vStride, uvW);
        }

        glUnmapBuffer(GL_PIXEL_UNPACK_BUFFER);
    }

    // Defensive: re-assert alignment=1 before each upload batch.
    // GL state is global mutable — guard against any intervening code that might
    // have changed it (e.g. third-party libs, GLFW internals on some drivers).
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);

    glBindTexture(GL_TEXTURE_2D, yTexture_);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width, height,
                    GL_RED, GL_UNSIGNED_BYTE, (void*)0);

    glBindTexture(GL_TEXTURE_2D, uTexture_);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, static_cast<GLsizei>(uvW),
                    static_cast<GLsizei>(uvH), GL_RED, GL_UNSIGNED_BYTE,
                    (void*)ySize);

    glBindTexture(GL_TEXTURE_2D, vTexture_);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, static_cast<GLsizei>(uvW),
                    static_cast<GLsizei>(uvH), GL_RED, GL_UNSIGNED_BYTE,
                    (void*)(ySize + uvSize));

    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);

    currentPBO_ = 1 - currentPBO_;
    hasFrame_ = true;

    auto t1 = std::chrono::high_resolution_clock::now();
    lastUploadMs_ = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (checkGLError("uploadFrame"))
    {
        std::cerr << "[VideoCompositor] uploadFrame params: w=" << width
                  << " h=" << height
                  << " yStride=" << yStride
                  << " uStride=" << uStride
                  << " vStride=" << vStride
                  << " ySize=" << ySize
                  << " uvSize=" << uvSize
                  << " mapped=" << (mapped ? "ok" : "null")
                  << "\n";
    }
}

// ── Legacy single-layer render ──────────────────────────────────────────────

void VideoCompositor::render()
{
    auto t0 = std::chrono::high_resolution_clock::now();

    int fbWidth, fbHeight;
    glfwGetFramebufferSize(window_, &fbWidth, &fbHeight);
    glViewport(0, 0, fbWidth, fbHeight);

    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    if (hasFrame_)
    {
        glUseProgram(shaderProgram_);

        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, yTexture_);
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, uTexture_);
        glActiveTexture(GL_TEXTURE2);
        glBindTexture(GL_TEXTURE_2D, vTexture_);

        glBindVertexArray(vao_);
        glDrawArrays(GL_TRIANGLES, 0, 6);
        glBindVertexArray(0);

        glUseProgram(0);
    }

    glfwSwapBuffers(window_);

    auto t1 = std::chrono::high_resolution_clock::now();
    lastRenderMs_ = std::chrono::duration<double, std::milli>(t1 - t0).count();

    checkGLError("render");
}

// ── Multi-layer: createTextureSet ───────────────────────────────────────────

int VideoCompositor::createTextureSet(int width, int height)
{
    TextureSet ts;
    ts.width  = width;
    ts.height = height;
    ts.yTex   = makeYuvTexture(width, height);
    ts.uTex   = makeYuvTexture(width / 2, height / 2);
    ts.vTex   = makeYuvTexture(width / 2, height / 2);

    int id = static_cast<int>(textureSets_.size());
    textureSets_.push_back(ts);

    checkGLError("createTextureSet");
    return id;
}

// ── Multi-layer: uploadFrameToSet ───────────────────────────────────────────

void VideoCompositor::uploadFrameToSet(int textureSetId,
                                       const uint8_t* yPlane, const uint8_t* uPlane,
                                       const uint8_t* vPlane,
                                       int width, int height,
                                       int yStride, int uStride, int vStride)
{
    if (textureSetId < 0 || textureSetId >= static_cast<int>(textureSets_.size()))
    {
        std::cerr << "[VideoCompositor] Invalid textureSetId: " << textureSetId << "\n";
        return;
    }

    auto t0 = std::chrono::high_resolution_clock::now();

    TextureSet& ts = textureSets_[textureSetId];

    // Recreate textures if size changed
    if (width != ts.width || height != ts.height)
    {
        if (ts.yTex) glDeleteTextures(1, &ts.yTex);
        if (ts.uTex) glDeleteTextures(1, &ts.uTex);
        if (ts.vTex) glDeleteTextures(1, &ts.vTex);
        ts.width  = width;
        ts.height = height;
        ts.yTex   = makeYuvTexture(width, height);
        ts.uTex   = makeYuvTexture(width / 2, height / 2);
        ts.vTex   = makeYuvTexture(width / 2, height / 2);
    }

    // Ensure PBOs are big enough for this frame
    size_t ySize  = static_cast<size_t>(width) * height;
    size_t uvW    = width / 2;
    size_t uvH    = height / 2;
    size_t uvSize = uvW * uvH;
    size_t totalNeeded = ySize + 2 * uvSize;

    // Lazily create/resize PBOs for the largest frame we've seen
    size_t currentPboCapacity = 0;
    if (frameWidth_ > 0 && frameHeight_ > 0)
    {
        size_t cy = static_cast<size_t>(frameWidth_) * frameHeight_;
        size_t cuv = static_cast<size_t>(frameWidth_ / 2) * (frameHeight_ / 2);
        currentPboCapacity = cy + 2 * cuv;
    }

    if (!pbo_[0] || totalNeeded > currentPboCapacity)
    {
        frameWidth_  = std::max(frameWidth_, width);
        frameHeight_ = std::max(frameHeight_, height);
        createPBOs(frameWidth_, frameHeight_);
    }

    // Upload via PBO
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, pbo_[currentPBO_]);

    uint8_t* mapped = static_cast<uint8_t*>(
        glMapBuffer(GL_PIXEL_UNPACK_BUFFER, GL_WRITE_ONLY));

    if (mapped)
    {
        // Copy Y
        if (yStride == width)
        {
            std::memcpy(mapped, yPlane, ySize);
        }
        else
        {
            for (int row = 0; row < height; ++row)
                std::memcpy(mapped + row * width, yPlane + row * yStride, width);
        }

        // Copy U
        uint8_t* uDst = mapped + ySize;
        if (uStride == static_cast<int>(uvW))
        {
            std::memcpy(uDst, uPlane, uvSize);
        }
        else
        {
            for (size_t row = 0; row < uvH; ++row)
                std::memcpy(uDst + row * uvW, uPlane + row * uStride, uvW);
        }

        // Copy V
        uint8_t* vDst = mapped + ySize + uvSize;
        if (vStride == static_cast<int>(uvW))
        {
            std::memcpy(vDst, vPlane, uvSize);
        }
        else
        {
            for (size_t row = 0; row < uvH; ++row)
                std::memcpy(vDst + row * uvW, vPlane + row * vStride, uvW);
        }

        glUnmapBuffer(GL_PIXEL_UNPACK_BUFFER);
    }

    // Defensive: re-assert alignment=1 before each upload batch (see uploadFrame).
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);

    // Upload Y from PBO -> texture
    glBindTexture(GL_TEXTURE_2D, ts.yTex);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width, height,
                    GL_RED, GL_UNSIGNED_BYTE, (void*)0);

    // Upload U
    glBindTexture(GL_TEXTURE_2D, ts.uTex);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, static_cast<GLsizei>(uvW),
                    static_cast<GLsizei>(uvH), GL_RED, GL_UNSIGNED_BYTE,
                    (void*)ySize);

    // Upload V
    glBindTexture(GL_TEXTURE_2D, ts.vTex);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, static_cast<GLsizei>(uvW),
                    static_cast<GLsizei>(uvH), GL_RED, GL_UNSIGNED_BYTE,
                    (void*)(ySize + uvSize));

    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);

    currentPBO_ = 1 - currentPBO_;
    ts.hasData = true;

    auto t1 = std::chrono::high_resolution_clock::now();
    lastUploadMs_ = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (checkGLError("uploadFrameToSet"))
    {
        std::cerr << "[VideoCompositor] uploadFrameToSet params: setId=" << textureSetId
                  << " w=" << width << " h=" << height
                  << " yStride=" << yStride
                  << " uStride=" << uStride
                  << " vStride=" << vStride
                  << " ySize=" << ySize
                  << " uvSize=" << uvSize
                  << " mapped=" << (mapped ? "ok" : "null")
                  << "\n";
    }
}

// ── Multi-layer: setLayer / setLayerCount ───────────────────────────────────

void VideoCompositor::setLayer(int layerIndex, const VideoLayer& layer)
{
    if (layerIndex < 0) return;
    if (layerIndex >= static_cast<int>(layers_.size()))
        layers_.resize(layerIndex + 1);
    layers_[layerIndex] = layer;
}

void VideoCompositor::setLayerCount(int count)
{
    activeLayerCount_ = count;
    if (static_cast<int>(layers_.size()) < count)
        layers_.resize(count);
}

// ── Multi-layer: renderComposite ────────────────────────────────────────────

void VideoCompositor::renderComposite()
{
    auto t0 = std::chrono::high_resolution_clock::now();

    int fbWidth, fbHeight;
    glfwGetFramebufferSize(window_, &fbWidth, &fbHeight);
    glViewport(0, 0, fbWidth, fbHeight);

    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    // Enable alpha blending
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    // Build sorted index list by zOrder (ascending — lowest drawn first)
    std::vector<int> sortedIndices;
    sortedIndices.reserve(activeLayerCount_);
    for (int i = 0; i < activeLayerCount_ && i < static_cast<int>(layers_.size()); ++i)
        sortedIndices.push_back(i);

    std::sort(sortedIndices.begin(), sortedIndices.end(),
              [this](int a, int b) { return layers_[a].zOrder < layers_[b].zOrder; });

    glUseProgram(compositeShaderProgram_);
    GLint locPos     = glGetUniformLocation(compositeShaderProgram_, "uPosition");
    GLint locScale   = glGetUniformLocation(compositeShaderProgram_, "uScale");
    GLint locOpacity = glGetUniformLocation(compositeShaderProgram_, "uOpacity");

    for (int idx : sortedIndices)
    {
        const VideoLayer& layer = layers_[idx];
        if (!layer.visible) continue;

        int tsId = layer.sourceTextureSet;
        if (tsId < 0 || tsId >= static_cast<int>(textureSets_.size())) continue;

        const TextureSet& ts = textureSets_[tsId];
        if (!ts.hasData) continue;

        // Set uniforms
        glUniform2f(locPos, layer.x, layer.y);
        glUniform2f(locScale, layer.width, layer.height);
        glUniform1f(locOpacity, layer.opacity);

        // Bind textures
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, ts.yTex);
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, ts.uTex);
        glActiveTexture(GL_TEXTURE2);
        glBindTexture(GL_TEXTURE_2D, ts.vTex);

        // Draw quad
        glBindVertexArray(vao_);
        glDrawArrays(GL_TRIANGLES, 0, 6);
        glBindVertexArray(0);
    }

    glUseProgram(0);
    glDisable(GL_BLEND);

    glfwSwapBuffers(window_);

    auto t1 = std::chrono::high_resolution_clock::now();
    lastRenderMs_ = std::chrono::duration<double, std::milli>(t1 - t0).count();

    checkGLError("renderComposite");
}

// ── GL context transfer ─────────────────────────────────────────────────────

void VideoCompositor::makeContextCurrent()
{
    if (window_)
        glfwMakeContextCurrent(window_);
}

void VideoCompositor::releaseContext()
{
    glfwMakeContextCurrent(nullptr);
}

// ── Window state ────────────────────────────────────────────────────────────

bool VideoCompositor::shouldClose() const
{
    return window_ ? glfwWindowShouldClose(window_) : true;
}

void VideoCompositor::pollEvents()
{
    glfwPollEvents();
}

double VideoCompositor::getLastUploadTimeMs() const { return lastUploadMs_; }
double VideoCompositor::getLastRenderTimeMs() const { return lastRenderMs_; }
