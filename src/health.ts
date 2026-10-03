/**
 * TARX CLI — Service Health Checker
 * Polls Bridge :11440, Mind :11435, Cognitive :11438, and Supercomputer broker.
 * Returns fast — 2s timeout per service, all checked in parallel.
 */

import type { ServiceStatus } from './ui.ts'

const SERVICES = {
  bridge:    'http://localhost:11440/health',
  mind:      'http://localhost:11435/health',
  cognitive: 'http://localhost:11438/health',
  broker:    'https://tarx-supercomputer-provider-staging.howdy-a3f.workers.dev/health',
}

async function checkOne(url: string): Promise<'up' | 'down'> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok ? 'up' : 'down'
  } catch {
    return 'down'
  }
}

export async function checkHealth(): Promise<ServiceStatus> {
  const [bridge, mind, cognitive, broker] = await Promise.all([
    checkOne(SERVICES.bridge),
    checkOne(SERVICES.mind),
    checkOne(SERVICES.cognitive),
    checkOne(SERVICES.broker),
  ])
  return { bridge, mind, cognitive, broker }
}

export function isHealthy(status: ServiceStatus): boolean {
  return status.bridge === 'up' && status.mind === 'up'
}
