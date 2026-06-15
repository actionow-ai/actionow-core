import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';

@Module({ controllers: [HealthController] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AppModule {}
