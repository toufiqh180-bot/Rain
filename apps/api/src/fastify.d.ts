import "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set on the Stripe webhook so the raw body is kept for signature checks. */
    rawBody?: boolean;
  }
}
