import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';

@Module({
  controllers: [ContractsController],
  providers: [],
  exports: [],
})
export class ContractsModule {}
