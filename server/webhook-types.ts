// --- Webhook event state machine ---
export type WebhookEventStatus =
  | 'received'
  | 'filtered'
  | 'duplicate'
  | 'debounced'
  | 'processing'
  | 'session_created'
  | 'completed'
  | 'error'
  | 'superseded'

export interface WebhookEvent {
  id: string                    // X-GitHub-Delivery ID
  idempotencyKey: string        // sha256 composite key
  receivedAt: string            // ISO timestamp
  event: string                 // X-GitHub-Event value
  action: string                // payload.action
  repo: string                  // owner/name
  branch: string                // head branch
  workflow: string              // workflow name
  runId: number                 // workflow run ID
  runAttempt: number            // run_attempt for re-runs
  conclusion: string            // success, failure, etc.
  status: WebhookEventStatus
  sessionId?: string            // if a session was created
  error?: string                // if processing failed
  filterReason?: string         // if filtered out, why
  // PR-specific fields (populated when event is pull_request)
  prNumber?: number              // PR number
  prTitle?: string               // PR title
  headSha?: string               // head commit SHA
  baseBranch?: string            // target branch
}

// --- GitHub payload subset (workflow_run) ---
export interface WorkflowRunPayload {
  action: string
  workflow_run: {
    id: number
    name: string
    run_number: number
    run_attempt: number
    head_branch: string
    head_sha: string
    conclusion: string | null
    event: string
    actor: { login: string }
    html_url: string
    check_suite_id: number
    pull_requests: Array<{
      number: number
      head: { ref: string; sha: string }
      base: { ref: string }
    }>
  }
  repository: {
    full_name: string
    name: string
    clone_url: string
  }
}

// --- CI failure context collected from gh CLI ---
export interface FailureContext {
  repo: string                  // owner/repo
  repoName: string              // short name
  branch: string
  headSha: string
  workflowName: string
  runId: number
  runNumber: number
  runAttempt: number
  actor: string
  event: string
  htmlUrl: string
  failedLogs: string            // truncated log output
  annotations: Annotation[]
  jobs: JobInfo[]
  pullRequest?: {
    number: number
    title?: string
  }
  commitMessage?: string
}

export interface Annotation {
  path: string
  startLine: number
  endLine: number
  message: string
  annotationLevel: string       // 'failure' | 'warning' | 'notice'
}

export interface JobInfo {
  id: number
  name: string
  conclusion: string
  steps: Array<{
    name: string
    number: number
    conclusion: string
  }>
}

// --- Dedup entry ---
export interface DedupEntry {
  processedAt: string
  eventId: string
}

/** Provider mode for automated PR reviews. */
export type PrReviewProviderMode = 'claude' | 'opencode' | 'split'

/**
 * Category for a provider failure — used by the webhook error classifier and
 * by the backlog / health subsystems to decide how to react.
 * See `server/webhook-error-classifier.ts` for the detection logic.
 */
export type ProviderUnhealthyReason = 'rate_limit' | 'auth_failure'

/** Current health snapshot for a single provider. Persisted to disk. */
export interface ProviderHealth {
  /** Last observed status for this provider. */
  status: 'healthy' | 'unhealthy'
  /** Why the provider is unhealthy. Unset when status='healthy'. */
  reason?: ProviderUnhealthyReason
  /** ISO timestamp when the unhealthy state was detected. Unset when healthy. */
  detectedAt?: string
  /** Truncated error text from the failing session. Unset when healthy. */
  lastError?: string
  /** ISO timestamp of the last successful review with this provider. */
  lastSuccessAt?: string
}

/** On-disk shape of `~/.codekin/provider-health.json`. */
export interface ProviderHealthFile {
  claude: ProviderHealth
  opencode: ProviderHealth
}

/**
 * A webhook event that failed due to provider unhealthy state and is queued
 * for retry. Persisted to `~/.codekin/webhook-backlog.json`.
 */
export interface BacklogEntry {
  /** UUID — used to remove entries after retry. */
  id: string
  /** GitHub repo in `owner/name` format. */
  repo: string
  /** PR number. */
  prNumber: number
  /** Head SHA at the time the event was enqueued. */
  headSha: string
  /** Full GitHub webhook payload — needed to re-fire the event later. */
  payload: PullRequestPayload
  /** Why this event was backlogged. */
  reason: ProviderUnhealthyReason
  /** Which provider(s) failed. `both` means split-mode failed twice. */
  failedProvider: 'claude' | 'opencode' | 'both'
  /** ISO timestamp when the entry was queued. */
  queuedAt: string
  /** ISO timestamp after which the retry worker should re-attempt. */
  retryAfter: string
  /** How many times this entry has been retried. */
  retryCount: number
}

// --- Webhook configuration (Phase 1 subset) ---
export interface WebhookConfig {
  enabled: boolean
  maxConcurrentSessions: number
  logLinesToInclude: number
  actorAllowlist: string[]
  prDebounceMs: number            // delay before processing PR events (coalesces rapid events)
  prReviewProvider: PrReviewProviderMode
  prReviewClaudeModel: string
  prReviewOpencodeModel: string
}

// --- GitHub payload subset (pull_request) ---
export interface PullRequestPayload {
  action: string
  number: number
  before?: string                 // previous head SHA (on synchronize)
  after?: string                  // new head SHA (on synchronize)
  pull_request: {
    number: number
    title: string
    body: string | null
    state: string                 // "open" | "closed"
    draft: boolean
    merged: boolean
    user: { login: string }
    head: {
      ref: string
      sha: string
      repo: { clone_url: string } | null
    }
    base: {
      ref: string
      sha: string
    }
    html_url: string
    changed_files: number
    additions: number
    deletions: number
  }
  repository: {
    full_name: string
    name: string
    clone_url: string
  }
  sender: { login: string }
}

// --- PR review context collected from gh CLI ---
export interface PullRequestContext {
  repo: string                    // owner/repo
  prNumber: number
  prTitle: string
  prBody: string
  prUrl: string
  author: string
  headBranch: string
  baseBranch: string
  headSha: string
  baseSha: string
  beforeSha?: string              // previous head SHA (on synchronize)
  action: 'opened' | 'synchronize' | 'reopened' | 'ready_for_review'
  changedFiles: number
  additions: number
  deletions: number
  diff: string                    // fetched via gh, potentially truncated
  fileList: string                // formatted list of changed files
  commitMessages: string          // formatted commit messages
  reviewComments: string          // existing inline review comments
  reviews: string                 // existing review summaries
  reviewProvider?: 'claude' | 'opencode'  // which engine is performing the review
  reviewModel?: string                     // model ID (e.g. 'sonnet' or 'openai/gpt-5.4')
}
