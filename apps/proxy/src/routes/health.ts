import type { FastifyInstance } from 'fastify'

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/healthz', async () => ({ status: 'ok' }))

  fastify.get('/readyz', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }))
}
