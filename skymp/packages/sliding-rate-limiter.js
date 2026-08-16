'use strict';

function createSlidingWindowRateLimiter({
  now = Date.now,
  sweepIntervalMs = 60_000,
  maxBuckets = 50_000
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now deve ser função');
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new TypeError('sweepIntervalMs deve ser inteiro positivo');
  }
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
    throw new TypeError('maxBuckets deve ser inteiro positivo');
  }

  const buckets = new Map();
  let nextSweepAt = 0;

  function sweep(currentTime = now()) {
    for (const [key, bucket] of buckets) {
      const active = bucket.timestamps.filter(timestamp => currentTime - timestamp < bucket.windowMs);
      if (active.length === 0) buckets.delete(key);
      else bucket.timestamps = active;
    }
    nextSweepAt = currentTime + sweepIntervalMs;
  }

  function isLimited(key, maxRequests, windowMs) {
    if (typeof key !== 'string' || key.length === 0) return true;
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) return true;
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) return true;

    const currentTime = now();
    if (currentTime >= nextSweepAt) sweep(currentTime);

    const existing = buckets.get(key);
    const timestamps = existing
      ? existing.timestamps.filter(timestamp => currentTime - timestamp < windowMs)
      : [];

    if (!existing && buckets.size >= maxBuckets) return true;

    if (timestamps.length >= maxRequests) {
      existing.timestamps = timestamps;
      existing.windowMs = windowMs;
      return true;
    }

    timestamps.push(currentTime);
    buckets.set(key, { timestamps, windowMs });
    return false;
  }

  return {
    isLimited,
    sweep,
    size: () => buckets.size,
    entrySize: key => buckets.get(key)?.timestamps.length ?? 0
  };
}

module.exports = { createSlidingWindowRateLimiter };
