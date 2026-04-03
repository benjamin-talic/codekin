/**
 * Per-PR context cache for webhook reviews.
 *
 * Stores Claude's prior review findings and codebase familiarity notes
 * so subsequent reviews of the same PR can build on prior context.
 *
 * Cache location: ~/.codekin/pr-cache/{owner}/{repo}/pr-{number}.json
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Shape of the cached PR review context. */
export interface PrCacheData {
  prNumber: number
  repo: string
  lastReviewedSha: string
  timestamp: string
  priorReviewSummary: string
  codebaseContext: string
  reviewFindings: string
}

const REQUIRED_FIELDS: (keyof PrCacheData)[] = [
  'prNumber', 'repo', 'lastReviewedSha', 'timestamp',
  'priorReviewSummary', 'codebaseContext', 'reviewFindings',
]

/**
 * Return the absolute path for a PR's cache file (pure, no side effects).
 */
export function getCachePath(repo: string, prNumber: number): string {
  const [owner, name] = repo.split('/')
  return join(homedir(), '.codekin', 'pr-cache', owner, name, `pr-${prNumber}.json`)
}

/**
 * Ensure the cache directory exists for a given repo, then return the cache file path.
 * Use this when the caller intends to write (or instruct Claude to write) the cache file.
 */
export function ensureCacheDir(repo: string, prNumber: number): string {
  const [owner, name] = repo.split('/')
  const dir = join(homedir(), '.codekin', 'pr-cache', owner, name)
  mkdirSync(dir, { recursive: true })
  return join(dir, `pr-${prNumber}.json`)
}

/**
 * Load cached review context for a PR.
 * Returns undefined if the cache doesn't exist, is malformed, or is missing required fields.
 */
export function loadPrCache(repo: string, prNumber: number): PrCacheData | undefined {
  const [owner, name] = repo.split('/')
  const cachePath = join(homedir(), '.codekin', 'pr-cache', owner, name, `pr-${prNumber}.json`)

  if (!existsSync(cachePath)) return undefined

  try {
    const raw = readFileSync(cachePath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>

    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (data[field] === undefined || data[field] === null) {
        console.warn(`[pr-cache] Cache for ${repo} PR #${prNumber} missing field '${field}', ignoring`)
        return undefined
      }
    }

    return data as unknown as PrCacheData
  } catch (err) {
    console.warn(`[pr-cache] Failed to load cache for ${repo} PR #${prNumber}:`, err)
    return undefined
  }
}
