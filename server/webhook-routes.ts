/**
 * REST routes for webhook and stepflow event management.
 *
 * Mounted at the Express app root (routes carry their own /api/ prefixes).
 * Note: the actual webhook receiver endpoints (/api/webhooks/github and
 * /api/webhooks/stepflow) remain in ws-server.ts because they require raw
 * body parsing before express.json() runs.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { WebhookHandler } from './webhook-handler.js'
import type { StepflowHandler } from './stepflow-handler.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createWebhookRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  webhookHandler: WebhookHandler,
  stepflowHandler: StepflowHandler,
): Router {
  const router = Router()

  // --- Webhook management endpoints ---

  router.get('/api/webhooks/events', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ events: webhookHandler.getEvents() })
  })

  router.get('/api/webhooks/events/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const event = webhookHandler.getEvent(req.params.id)
    if (event) {
      res.json({ event })
    } else {
      res.status(404).json({ error: 'Event not found' })
    }
  })

  router.get('/api/webhooks/config', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ config: webhookHandler.getConfig() })
  })

  /**
   * Provider health + backlog snapshot.
   *
   * Returns the last known status for each review provider (`claude` and
   * `opencode`) plus the current retry backlog size. Provider health is
   * observational only — routing never short-circuits on unhealthy state.
   * A provider flips back to healthy on the next successful review.
   *
   * Response shape:
   *   {
   *     claude:   { status, reason?, detectedAt?, lastError?, lastSuccessAt? },
   *     opencode: { status, reason?, detectedAt?, lastError?, lastSuccessAt? },
   *     backlog:  <number of queued retries>
   *   }
   */
  router.get('/api/webhooks/health', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const providers = webhookHandler.getProviderHealth()
    res.json({
      claude: providers.claude,
      opencode: providers.opencode,
      backlog: webhookHandler.getBacklogSize(),
    })
  })

  // --- Stepflow management endpoints ---

  router.get('/api/stepflow/events', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ events: stepflowHandler.getEvents() })
  })

  router.get('/api/stepflow/events/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const event = stepflowHandler.getEvent(req.params.id)
    if (event) {
      res.json({ event })
    } else {
      res.status(404).json({ error: 'Event not found' })
    }
  })

  return router
}
