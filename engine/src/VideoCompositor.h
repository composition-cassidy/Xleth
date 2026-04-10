#pragma once

#include "VideoLayer.h"

#include <GL/glew.h>
#include <GLFW/glfw3.h>

#include <cstdint>
#include <string>
#include <vector>

class VideoCompositor {
public:
    VideoCompositor();
    ~VideoCompositor();

    // Create OpenGL context and window. Call once at startup.
    bool initialize(int windowWidth, int windowHeight, const std::string& title);
    void shutdown();

    // Upload a decoded YUV420 frame to GPU textures.
    // Uses PBO double-buffering for async upload.
    void uploadFrame(const uint8_t* yPlane, const uint8_t* uPlane, const uint8_t* vPlane,
                     int width, int height,
                     int yStride, int uStride, int vStride);

    // Render the current frame texture to the window (single-layer, legacy).
    void render();

    // ── Multi-layer API ─────────────────────────────────────────────────────

    // Register a new texture set for a source. Returns sourceTextureSet ID.
    int createTextureSet(int width, int height);

    // Upload a frame to a specific texture set
    void uploadFrameToSet(int textureSetId,
                          const uint8_t* yPlane, const uint8_t* uPlane, const uint8_t* vPlane,
                          int width, int height,
                          int yStride, int uStride, int vStride);

    // Set layer properties
    void setLayer(int layerIndex, const VideoLayer& layer);

    // Set number of active layers
    void setLayerCount(int count);

    // Render all visible layers composited together
    void renderComposite();

    // ── Window / stats ──────────────────────────────────────────────────────

    // GL context transfer — use to move rendering to a different thread
    void makeContextCurrent();  // glfwMakeContextCurrent(window_)
    void releaseContext();      // glfwMakeContextCurrent(nullptr)

    // Check if window should close
    bool shouldClose() const;

    // Poll window events (must call from main thread)
    void pollEvents();

    // Performance stats
    double getLastUploadTimeMs() const;
    double getLastRenderTimeMs() const;

private:
    GLFWwindow* window_ = nullptr;

    // Three textures for Y, U, V planes (single-layer legacy)
    GLuint yTexture_ = 0;
    GLuint uTexture_ = 0;
    GLuint vTexture_ = 0;

    // PBO double-buffer for async upload
    GLuint pbo_[2] = {0, 0};
    int currentPBO_ = 0;

    // Shader program for YUV->RGB conversion (single-layer, legacy)
    GLuint shaderProgram_ = 0;

    // Composite shader with position/scale/opacity uniforms
    GLuint compositeShaderProgram_ = 0;

    // Fullscreen quad VAO/VBO
    GLuint vao_ = 0;
    GLuint vbo_ = 0;

    int frameWidth_ = 0;
    int frameHeight_ = 0;
    bool hasFrame_ = false;

    double lastUploadMs_ = 0.0;
    double lastRenderMs_ = 0.0;

    // ── Multi-layer state ───────────────────────────────────────────────────

    struct TextureSet {
        GLuint yTex = 0, uTex = 0, vTex = 0;
        int width = 0, height = 0;
        bool hasData = false;
    };
    std::vector<TextureSet> textureSets_;

    std::vector<VideoLayer> layers_;
    int activeLayerCount_ = 0;

    // ── Internal helpers ────────────────────────────────────────────────────

    bool createShaders();
    bool createCompositeShader();
    bool createQuad();
    bool createTextures(int width, int height);
    bool createPBOs(int width, int height);
    bool checkGLError(const char* context);

    static GLuint makeYuvTexture(int w, int h);
    static void uploadPlaneViaPBO(GLuint pbo, GLuint texture,
                                  const uint8_t* data, int width, int height,
                                  int stride);
};
