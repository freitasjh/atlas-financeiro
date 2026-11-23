import { Body, Controller, Post } from '@nestjs/common';
import {
  healthEnvelopeSchema,
  type HealthEnvelope,
} from '@shared/v1';

@Controller('contracts')
export class ContractsController {
  @Post('validate')
  validate(@Body({ schema: healthEnvelopeSchema }) _body: HealthEnvelope) {
    return { valid: true };
  }
}
