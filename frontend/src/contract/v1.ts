// Única borda de dados: o diretório v1 congelado. "v1" é versão do contrato,
// não da biblioteca (zod ^4.6.7). Nenhum import de app/service/provider.
export {
  fieldErrorEnvelopeSchema,
  healthEnvelopeSchema,
  healthStatusSchema,
  type FieldErrorEnvelope,
  type HealthEnvelope,
  type HealthStatus,
} from '../../../backend/libs/shared-contracts/src/v1'
