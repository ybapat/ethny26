cmake_minimum_required(VERSION 3.20)
project(perp_dex_matching_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ── External dependencies ──────────────────────────────────────────────────

find_package(Boost 1.81 REQUIRED COMPONENTS system)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

include(FetchContent)
FetchContent_Declare(nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(nlohmann_json)

# ── Core library (everything except main) ─────────────────────────────────

add_library(engine_core
  src/orderbook.cpp
  src/engine.cpp
  src/ledger.cpp
  src/recovery.cpp
)
target_include_directories(engine_core PUBLIC src)
target_link_libraries(engine_core PUBLIC
  Boost::system
  OpenSSL::SSL
  OpenSSL::Crypto
  Threads::Threads
  nlohmann_json::nlohmann_json
)
target_compile_options(engine_core PRIVATE -Wall -Wextra -Wpedantic -O2)

# ── Main executable ────────────────────────────────────────────────────────

add_executable(matching_engine src/main.cpp)
target_link_libraries(matching_engine PRIVATE engine_core)
target_compile_options(matching_engine PRIVATE -Wall -Wextra -O2)

# ── Tests ─────────────────────────────────────────────────────────────────

add_executable(test_orderbook tests/test_orderbook.cpp src/orderbook.cpp)
target_include_directories(test_orderbook PRIVATE src)
target_link_libraries(test_orderbook PRIVATE nlohmann_json::nlohmann_json)
target_compile_options(test_orderbook PRIVATE -Wall -Wextra -O2)

add_executable(test_engine tests/test_engine.cpp src/orderbook.cpp src/engine.cpp)
target_include_directories(test_engine PRIVATE src)
target_link_libraries(test_engine PRIVATE
  Boost::system
  nlohmann_json::nlohmann_json
  Threads::Threads
)
target_compile_options(test_engine PRIVATE -Wall -Wextra -O2)

enable_testing()
add_test(NAME orderbook COMMAND test_orderbook)
add_test(NAME engine    COMMAND test_engine)
