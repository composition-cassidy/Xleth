// lifo_same_size_allocator.h -- replaces global operator new/delete with a
// same-size LIFO allocator, so a freed block is ALWAYS the next allocation of
// that size. Makes address reuse (the ABA behind stale-pointer bugs) happen on
// every iteration instead of by heap lottery.
//
// Include in exactly ONE translation unit of a test binary: it defines the
// replaceable global allocation functions.
#pragma once

#include <atomic>
#include <cstdlib>
#include <new>

// ── Same-size LIFO allocator (whole test binary) ─────────────────────────────
// A freed block goes on a per-size free list and is handed to the next
// allocation of exactly that size. Never returns memory to the CRT; bounded by
// the peak, which is fine for a test.
namespace lifo {

struct Block { Block* next; };
struct Bucket { std::size_t size; Block* head; };

constexpr std::size_t kHeader  = 16;     // keeps the 16-byte new alignment
constexpr std::size_t kBuckets = 1 << 14;
Bucket           g_buckets[kBuckets];   // zero-initialised: size 0 = empty slot
std::atomic_flag g_lock = ATOMIC_FLAG_INIT;

struct Guard
{
    Guard()  { while (g_lock.test_and_set(std::memory_order_acquire)) {} }
    ~Guard() { g_lock.clear(std::memory_order_release); }
};

Bucket* bucketFor(std::size_t size)   // caller holds g_lock
{
    for (std::size_t i = (size * 0x9E3779B97F4A7C15ull) >> 50, n = 0; n < kBuckets;
         i = (i + 1) & (kBuckets - 1), ++n)
    {
        if (g_buckets[i].size == size) return &g_buckets[i];
        if (g_buckets[i].size == 0) { g_buckets[i].size = size; return &g_buckets[i]; }
    }
    return nullptr;                      // table full: fall back to plain malloc/free
}

void* allocate(std::size_t size)
{
    if (size == 0) size = 1;
    {
        Guard g;
        if (Bucket* b = bucketFor(size); b && b->head)
        {
            Block* blk = b->head;
            b->head = blk->next;
            return blk;
        }
    }
    auto* raw = static_cast<unsigned char*>(std::malloc(size + kHeader));
    if (raw == nullptr) throw std::bad_alloc();
    *reinterpret_cast<std::size_t*>(raw) = size;
    return raw + kHeader;
}

void release(void* p)
{
    if (p == nullptr) return;
    auto* raw = static_cast<unsigned char*>(p) - kHeader;
    const std::size_t size = *reinterpret_cast<std::size_t*>(raw);
    Guard g;
    if (Bucket* b = bucketFor(size))
    {
        auto* blk = static_cast<Block*>(p);
        blk->next = b->head;
        b->head = blk;
        return;
    }
    std::free(raw);
}

} // namespace lifo

void* operator new(std::size_t n)                                    { return lifo::allocate(n); }
void* operator new[](std::size_t n)                                  { return lifo::allocate(n); }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept    { try { return lifo::allocate(n); } catch (...) { return nullptr; } }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept  { try { return lifo::allocate(n); } catch (...) { return nullptr; } }
void  operator delete(void* p) noexcept                              { lifo::release(p); }
void  operator delete[](void* p) noexcept                            { lifo::release(p); }
void  operator delete(void* p, std::size_t) noexcept                 { lifo::release(p); }
void  operator delete[](void* p, std::size_t) noexcept               { lifo::release(p); }
void  operator delete(void* p, const std::nothrow_t&) noexcept       { lifo::release(p); }
void  operator delete[](void* p, const std::nothrow_t&) noexcept     { lifo::release(p); }
