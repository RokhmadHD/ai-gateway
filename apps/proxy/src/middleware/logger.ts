import type { FastifyInstance } from 'fastify'

export async function loggerMiddleware(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request) => {
    request.log.info({ method: request.method, url: request.url }, 'incoming request')
  })

  fastify.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'request completed',
    )
  })
}
