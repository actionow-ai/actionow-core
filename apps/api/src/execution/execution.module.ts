import { Module } from '@nestjs/common';

import { AuthService } from '../auth/auth.service.js';
import { RunController } from './run.controller.js';
import { RunService } from './run.service.js';

/** Wires `POST /v1/run/:resourceId` (the {@link RunController}) and its deps. */
@Module({
  controllers: [RunController],
  providers: [RunService, AuthService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ExecutionModule {}
