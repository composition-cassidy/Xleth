cmake_minimum_required(VERSION 3.28)

# Use vcpkg toolchain if VCPKG_ROOT is set, else fall back to VS2022's bundled
# vcpkg. Without a toolchain here, this is the ONLY place FFmpeg/GLEW/glfw3
# ever get installed into build/vcpkg_installed — bridge/CMakeLists.txt and
# engine/CMakeLists.txt both only *reuse* that pre-installed tree, they don't
# bootstrap it. See the matching fallback in bridge/CMakeLists.txt.
if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
    if(DEFINED ENV{VCPKG_ROOT})
        set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
            CACHE STRING "Vcpkg toolchain file")
    elseif(EXISTS "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/vcpkg/scripts/buildsystems/vcpkg.cmake")
        set(CMAKE_TOOLCHAIN_FILE
            "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/vcpkg/scripts/buildsystems/vcpkg.cmake"
            CACHE STRING "vcpkg toolchain file (VS2022 bundled)")
    endif()
endif()

project(Xleth VERSION 0.0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Register the engine's self-test executables with CTest.
# Run them all with:  ctest --test-dir build -C Release
enable_testing()

add_subdirectory(engine)
add_subdirectory(scanner)
add_subdirectory(editor-host)
