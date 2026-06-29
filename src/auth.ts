import { FastifyReply, FastifyRequest } from "fastify";

export function requireApiKey(apiKey: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (header !== `Bearer ${apiKey}`) {
      reply.code(401).send({ error: "unauthorized" });
    }
  };
}
