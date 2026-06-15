import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mount the OpenAPI spec + Swagger UI at `/docs` (§4.6 docs surface). Two bearer
 * schemes are declared so the spec documents both auth surfaces: an `api-key`
 * bearer for `/v1/*` (the API key) and a `jwt` bearer for `/admin/*`. Kept in
 * its own module (no `bootstrap` side effects) so the e2e harness can mount docs
 * on the `Test` app the same way `main.ts` does.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Actionow API')
    .setDescription('Unified AI gateway — /v1 run/jobs (API key) and /admin (admin JWT).')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'api-key')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}
