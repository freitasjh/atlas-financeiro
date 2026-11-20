
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "accounts": {
                  Row: {
                    "account_digit": string | null,"account_number": string | null,"agency": string | null,"color": string | null,"connection_status": string,"created_at": string,"current_balance_cents": number,"id": string,"initial_balance_cents": number,"institution": string | null,"is_default": boolean,"name": string,"tenant_id": string | null,"type": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_digit"?: string | null,"account_number"?: string | null,"agency"?: string | null,"color"?: string | null,"connection_status"?: string,"created_at"?: string,"current_balance_cents"?: number,"id"?: string,"initial_balance_cents"?: number,"institution"?: string | null,"is_default"?: boolean,"name": string,"tenant_id"?: string | null,"type": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_digit"?: string | null,"account_number"?: string | null,"agency"?: string | null,"color"?: string | null,"connection_status"?: string,"created_at"?: string,"current_balance_cents"?: number,"id"?: string,"initial_balance_cents"?: number,"institution"?: string | null,"is_default"?: boolean,"name"?: string,"tenant_id"?: string | null,"type"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "accounts_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "accounts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"admin_audit": {
                  Row: {
                    "action": string,"actor_id": string | null,"at": string,"from_value": string | null,"id": string,"reason": string | null,"target_id": string,"tenant_id": string | null,"to_value": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"at"?: string,"from_value"?: string | null,"id"?: string,"reason"?: string | null,"target_id": string,"tenant_id"?: string | null,"to_value"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"at"?: string,"from_value"?: string | null,"id"?: string,"reason"?: string | null,"target_id"?: string,"tenant_id"?: string | null,"to_value"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"budgets": {
                  Row: {
                    "category_id": string,"created_at": string,"id": string,"limit_cents": number,"month": string,"tenant_id": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"created_at"?: string,"id"?: string,"limit_cents"?: number,"month": string,"tenant_id"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "category_id"?: string,"created_at"?: string,"id"?: string,"limit_cents"?: number,"month"?: string,"tenant_id"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budgets_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "budgets_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "budgets_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"categories": {
                  Row: {
                    "color_hex": string | null,"created_at": string,"icon_code": string | null,"id": string,"name": string,"parent_id": string | null,"spending_limit_cents": number,"type": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color_hex"?: string | null,"created_at"?: string,"icon_code"?: string | null,"id"?: string,"name": string,"parent_id"?: string | null,"spending_limit_cents"?: number,"type": string,"user_id": string
                  }
                  Update: {
                    "color_hex"?: string | null,"created_at"?: string,"icon_code"?: string | null,"id"?: string,"name"?: string,"parent_id"?: string | null,"spending_limit_cents"?: number,"type"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "categories_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_acceptances": {
                  Row: {
                    "accepted_at": string,"contract_version": string,"id": number,"tenant_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string,"contract_version": string,"id"?: never,"tenant_id": string,"user_id": string
                  }
                  Update: {
                    "accepted_at"?: string,"contract_version"?: string,"id"?: never,"tenant_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_acceptances_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contract_acceptances_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"credit_cards": {
                  Row: {
                    "account_id": string,"closing_day": number,"created_at": string,"due_day": number,"expiry_mm_aa": string | null,"holder_name": string | null,"id": string,"is_default": boolean,"last4": string | null,"limit_cents": number,"name": string,"tenant_id": string | null,"theme": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"closing_day": number,"created_at"?: string,"due_day": number,"expiry_mm_aa"?: string | null,"holder_name"?: string | null,"id"?: string,"is_default"?: boolean,"last4"?: string | null,"limit_cents"?: number,"name": string,"tenant_id"?: string | null,"theme"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_id"?: string,"closing_day"?: number,"created_at"?: string,"due_day"?: number,"expiry_mm_aa"?: string | null,"holder_name"?: string | null,"id"?: string,"is_default"?: boolean,"last4"?: string | null,"limit_cents"?: number,"name"?: string,"tenant_id"?: string | null,"theme"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "credit_cards_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "credit_cards_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "credit_cards_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"impersonation_sessions": {
                  Row: {
                    "ended_at": string | null,"expires_at": string,"id": string,"last_read_at": string | null,"operator_id": string,"reads": number,"reason": string,"revoked_at": string | null,"started_at": string,"tenant_id": string,"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ended_at"?: string | null,"expires_at": string,"id"?: string,"last_read_at"?: string | null,"operator_id": string,"reads"?: number,"reason": string,"revoked_at"?: string | null,"started_at"?: string,"tenant_id": string,"token_hash": string
                  }
                  Update: {
                    "ended_at"?: string | null,"expires_at"?: string,"id"?: string,"last_read_at"?: string | null,"operator_id"?: string,"reads"?: number,"reason"?: string,"revoked_at"?: string | null,"started_at"?: string,"tenant_id"?: string,"token_hash"?: string
                  }
                  Relationships: [
                    
                  ]
                },"installment_plans": {
                  Row: {
                    "created_at": string,"description": string,"id": string,"total_amount_cents": number,"total_installments": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description": string,"id"?: string,"total_amount_cents": number,"total_installments": number,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string,"id"?: string,"total_amount_cents"?: number,"total_installments"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "installment_plans_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"internal_operators": {
                  Row: {
                    "active": boolean,"created_at": string,"created_by": string | null,"disabled_at": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"disabled_at"?: string | null,"user_id": string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"created_by"?: string | null,"disabled_at"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"invoices": {
                  Row: {
                    "created_at": string,"credit_card_id": string,"due_date": string,"id": string,"paid_at": string | null,"paid_cents": number,"period_end": string,"period_start": string,"status": string,"total_cents": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"credit_card_id": string,"due_date": string,"id"?: string,"paid_at"?: string | null,"paid_cents"?: number,"period_end": string,"period_start": string,"status"?: string,"total_cents"?: number,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"credit_card_id"?: string,"due_date"?: string,"id"?: string,"paid_at"?: string | null,"paid_cents"?: number,"period_end"?: string,"period_start"?: string,"status"?: string,"total_cents"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invoices_credit_card_id_fkey"
      columns: ["credit_card_id"]
isOneToOne: false
      referencedRelation: "credit_cards"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoices_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"plan_catalog": {
                  Row: {
                    "created_at": string,"price_cents": number,"slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"price_cents": number,"slug": string
                  }
                  Update: {
                    "created_at"?: string,"price_cents"?: number,"slug"?: string
                  }
                  Relationships: [
                    
                  ]
                },"plan_limits": {
                  Row: {
                    "max_accounts": number | null,"max_budgets": number | null,"max_credit_cards": number | null,"max_members": number | null,"max_transactions_month": number | null,"plan_slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "max_accounts"?: number | null,"max_budgets"?: number | null,"max_credit_cards"?: number | null,"max_members"?: number | null,"max_transactions_month"?: number | null,"plan_slug": string
                  }
                  Update: {
                    "max_accounts"?: number | null,"max_budgets"?: number | null,"max_credit_cards"?: number | null,"max_members"?: number | null,"max_transactions_month"?: number | null,"plan_slug"?: string
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"full_name": string | null,"id": string,"must_change_password": boolean,"role": string,"subscription_status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"full_name"?: string | null,"id": string,"must_change_password"?: boolean,"role"?: string,"subscription_status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"full_name"?: string | null,"id"?: string,"must_change_password"?: boolean,"role"?: string,"subscription_status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"psp_events": {
                  Row: {
                    "attempts": number,"event_id": string,"event_kind": string | null,"event_type": string,"id": string,"payload": NonNullable<Json>,"payload_scrubbed_at": string | null,"process_outcome": string | null,"process_reason": string | null,"processed_at": string | null,"provider": string,"psp_event_at": string | null,"psp_invoice_id": string | null,"psp_payment_id": string | null,"psp_subscription_id": string | null,"received_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"event_id": string,"event_kind"?: string | null,"event_type": string,"id"?: string,"payload": NonNullable<Json>,"payload_scrubbed_at"?: string | null,"process_outcome"?: string | null,"process_reason"?: string | null,"processed_at"?: string | null,"provider"?: string,"psp_event_at"?: string | null,"psp_invoice_id"?: string | null,"psp_payment_id"?: string | null,"psp_subscription_id"?: string | null,"received_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"event_id"?: string,"event_kind"?: string | null,"event_type"?: string,"id"?: string,"payload"?: NonNullable<Json>,"payload_scrubbed_at"?: string | null,"process_outcome"?: string | null,"process_reason"?: string | null,"processed_at"?: string | null,"provider"?: string,"psp_event_at"?: string | null,"psp_invoice_id"?: string | null,"psp_payment_id"?: string | null,"psp_subscription_id"?: string | null,"received_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rules": {
                  Row: {
                    "created_at": string,"id": string,"keyword": string,"priority": number,"target_category_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"keyword": string,"priority"?: number,"target_category_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"keyword"?: string,"priority"?: number,"target_category_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rules_target_category_id_fkey"
      columns: ["target_category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rules_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_invoices": {
                  Row: {
                    "amount_cents": number,"competencia": string,"created_at": string,"due_date": string,"id": string,"kind": string,"paid_at": string | null,"period_end": string,"period_start": string,"psp_invoice_id": string | null,"psp_payment_id": string | null,"status": string,"subscription_id": string,"tenant_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_cents": number,"competencia": string,"created_at"?: string,"due_date": string,"id"?: string,"kind"?: string,"paid_at"?: string | null,"period_end": string,"period_start": string,"psp_invoice_id"?: string | null,"psp_payment_id"?: string | null,"status"?: string,"subscription_id": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount_cents"?: number,"competencia"?: string,"created_at"?: string,"due_date"?: string,"id"?: string,"kind"?: string,"paid_at"?: string | null,"period_end"?: string,"period_start"?: string,"psp_invoice_id"?: string | null,"psp_payment_id"?: string | null,"status"?: string,"subscription_id"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_invoices_subscription_id_fkey"
      columns: ["subscription_id"]
isOneToOne: false
      referencedRelation: "tenant_subscriptions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_invoices_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_members": {
                  Row: {
                    "created_at": string,"role": string,"tenant_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"role"?: string,"tenant_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"role"?: string,"tenant_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_members_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_members_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_subscriptions": {
                  Row: {
                    "billing_day": number | null,"cancel_at_period_end": boolean,"created_at": string,"id": string,"last_event_at": string | null,"last_event_id": string | null,"past_due_since": string | null,"pending_plan_at": string | null,"pending_plan_slug": string | null,"period_end": string | null,"period_start": string | null,"plan_slug": string,"psp_customer_id": string | null,"psp_subscription_id": string | null,"status": string,"tenant_id": string,"trial_ends_at": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_day"?: number | null,"cancel_at_period_end"?: boolean,"created_at"?: string,"id"?: string,"last_event_at"?: string | null,"last_event_id"?: string | null,"past_due_since"?: string | null,"pending_plan_at"?: string | null,"pending_plan_slug"?: string | null,"period_end"?: string | null,"period_start"?: string | null,"plan_slug": string,"psp_customer_id"?: string | null,"psp_subscription_id"?: string | null,"status"?: string,"tenant_id": string,"trial_ends_at"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "billing_day"?: number | null,"cancel_at_period_end"?: boolean,"created_at"?: string,"id"?: string,"last_event_at"?: string | null,"last_event_id"?: string | null,"past_due_since"?: string | null,"pending_plan_at"?: string | null,"pending_plan_slug"?: string | null,"period_end"?: string | null,"period_start"?: string | null,"plan_slug"?: string,"psp_customer_id"?: string | null,"psp_subscription_id"?: string | null,"status"?: string,"tenant_id"?: string,"trial_ends_at"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_subscriptions_pending_plan_slug_fkey"
      columns: ["pending_plan_slug"]
isOneToOne: false
      referencedRelation: "plan_catalog"
      referencedColumns: ["slug"]
    },{
      foreignKeyName: "tenant_subscriptions_plan_slug_fkey"
      columns: ["plan_slug"]
isOneToOne: false
      referencedRelation: "plan_catalog"
      referencedColumns: ["slug"]
    },{
      foreignKeyName: "tenant_subscriptions_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: true
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_switches": {
                  Row: {
                    "actor_id": string | null,"from_tenant_id": string | null,"id": string,"source": string,"switched_at": string,"to_tenant_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"from_tenant_id"?: string | null,"id"?: string,"source"?: string,"switched_at"?: string,"to_tenant_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"from_tenant_id"?: string | null,"id"?: string,"source"?: string,"switched_at"?: string,"to_tenant_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"tenants": {
                  Row: {
                    "cnpj": string | null,"cpf": string | null,"created_at": string,"endereco_bairro": string | null,"endereco_cep": string | null,"endereco_cidade": string | null,"endereco_complemento": string | null,"endereco_logradouro": string | null,"endereco_numero": string | null,"endereco_uf": string | null,"id": string,"kind": string,"nome_fantasia": string | null,"owner_user_id": string,"phone": string | null,"plan_id": string,"razao_social": string,"subscription_status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cnpj"?: string | null,"cpf"?: string | null,"created_at"?: string,"endereco_bairro"?: string | null,"endereco_cep"?: string | null,"endereco_cidade"?: string | null,"endereco_complemento"?: string | null,"endereco_logradouro"?: string | null,"endereco_numero"?: string | null,"endereco_uf"?: string | null,"id"?: string,"kind": string,"nome_fantasia"?: string | null,"owner_user_id": string,"phone"?: string | null,"plan_id"?: string,"razao_social": string,"subscription_status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "cnpj"?: string | null,"cpf"?: string | null,"created_at"?: string,"endereco_bairro"?: string | null,"endereco_cep"?: string | null,"endereco_cidade"?: string | null,"endereco_complemento"?: string | null,"endereco_logradouro"?: string | null,"endereco_numero"?: string | null,"endereco_uf"?: string | null,"id"?: string,"kind"?: string,"nome_fantasia"?: string | null,"owner_user_id"?: string,"phone"?: string | null,"plan_id"?: string,"razao_social"?: string,"subscription_status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenants_owner_user_id_fkey"
      columns: ["owner_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"transactions": {
                  Row: {
                    "account_id": string,"amount_cents": number,"category_id": string | null,"created_at": string,"date": string,"dedup_hash": string | null,"description": string,"fitid": string | null,"id": string,"installment_number": number | null,"installment_plan_id": string | null,"invoice_id": string | null,"is_transfer": boolean,"reconciled": boolean,"split_group_id": string | null,"tenant_id": string | null,"transfer_destination_account_id": string | null,"type": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"amount_cents": number,"category_id"?: string | null,"created_at"?: string,"date": string,"dedup_hash"?: string | null,"description"?: string,"fitid"?: string | null,"id"?: string,"installment_number"?: number | null,"installment_plan_id"?: string | null,"invoice_id"?: string | null,"is_transfer"?: boolean,"reconciled"?: boolean,"split_group_id"?: string | null,"tenant_id"?: string | null,"transfer_destination_account_id"?: string | null,"type"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_id"?: string,"amount_cents"?: number,"category_id"?: string | null,"created_at"?: string,"date"?: string,"dedup_hash"?: string | null,"description"?: string,"fitid"?: string | null,"id"?: string,"installment_number"?: number | null,"installment_plan_id"?: string | null,"invoice_id"?: string | null,"is_transfer"?: boolean,"reconciled"?: boolean,"split_group_id"?: string | null,"tenant_id"?: string | null,"transfer_destination_account_id"?: string | null,"type"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transactions_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_installment_plan_id_fkey"
      columns: ["installment_plan_id"]
isOneToOne: false
      referencedRelation: "installment_plans"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_invoice_id_fkey"
      columns: ["invoice_id"]
isOneToOne: false
      referencedRelation: "invoices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_transfer_destination_account_id_fkey"
      columns: ["transfer_destination_account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"usage_events": {
                  Row: {
                    "competencia": string,"dedup_key": string,"id": string,"occurred_at": string,"tenant_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "competencia": string,"dedup_key": string,"id"?: string,"occurred_at"?: string,"tenant_id": string
                  }
                  Update: {
                    "competencia"?: string,"dedup_key"?: string,"id"?: string,"occurred_at"?: string,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "usage_events_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"user_active_tenants": {
                  Row: {
                    "switched_at": string,"tenant_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "switched_at"?: string,"tenant_id": string,"user_id": string
                  }
                  Update: {
                    "switched_at"?: string,"tenant_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_active_tenants_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_active_tenants_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_contract":
{ Args: { "p_contract_version": string,"p_tenant_id": string }; Returns: number
                           },
"admin_cancel_invite":
{ Args: { "p_target": string }; Returns: boolean
                           },
"admin_count_tenants":
{ Args: { "p_search"?: string,"p_status"?: string }; Returns: number
                           },
"admin_get_tenant":
{ Args: { "p_tenant": string }; Returns: {
              "created_at": string,"document": string,"id": string,"kind": string,"nome_fantasia": string,"plan_id": string,"razao_social": string,"subscription_status": string
            }[]
                           },
"admin_get_tenant_billing":
{ Args: { "p_tenant": string }; Returns: Json
                           },
"admin_grant_super_admin":
{ Args: { "p_target": string }; Returns: undefined
                           },
"admin_invite_quota":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"admin_list_impersonation_sessions":
{ Args: { "p_limit"?: number,"p_offset"?: number,"p_operator"?: string }; Returns: {
              "ended_at": string,"expires_at": string,"id": string,"last_read_at": string,"operator_id": string,"reads": number,"reason": string,"revoked_at": string,"started_at": string,"tenant_id": string
            }[]
                           },
"admin_list_members":
{ Args: { "p_tenant": string }; Returns: {
              "created_at": string,"role": string,"user_id": string
            }[]
                           },
"admin_list_pending_invites":
{ Args: { "p_limit"?: number,"p_offset"?: number }; Returns: {
              "age_hours": number,"invited_user_id": string,"requested_at": string,"state": string
            }[]
                           },
"admin_list_tenant_switches":
{ Args: { "p_limit"?: number,"p_offset"?: number,"p_tenant"?: string }; Returns: {
              "actor_id": string,"from_tenant_id": string,"source": string,"switched_at": string,"to_tenant_id": string
            }[]
                           },
"admin_list_tenants":
{ Args: { "p_dir"?: string,"p_limit"?: number,"p_offset"?: number,"p_search"?: string,"p_sort"?: string,"p_status"?: string }; Returns: {
              "cnpj": string,"cpf": string,"created_at": string,"id": string,"kind": string,"nome_fantasia": string,"owner_user_id": string,"plan_id": string,"razao_social": string,"subscription_status": string
            }[]
                           },
"admin_mrr_summary":
{ Args: { "p_competencia"?: string }; Returns: Json
                           },
"admin_override_subscription":
{ Args: { "p_competencia"?: string,"p_plan"?: string,"p_reason"?: string,"p_status"?: string,"p_tenant": string }; Returns: Json
                           },
"admin_record_invite":
{ Args: { "p_target": string }; Returns: undefined
                           },
"admin_register_override":
{ Args: { "p_reason": string,"p_resource_type": string,"p_tenant_id": string }; Returns: undefined
                           },
"admin_repair_tenant_onboarding":
{ Args: { "p_contract_version"?: string,"p_tenant": string }; Returns: string
                           },
"admin_resolve_invited_user":
{ Args: { "p_email": string }; Returns: string
                           },
"admin_revoke_super_admin":
{ Args: { "p_target": string }; Returns: undefined
                           },
"admin_set_tenant_status":
{ Args: { "p_plan"?: string,"p_reason"?: string,"p_status": string,"p_tenant": string }; Returns: undefined
                           },
"admin_sweep_impersonation_sessions":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"admin_tenant_onboarding_state":
{ Args: { "p_tenant": string }; Returns: {
              "missing": (string)[],"state": string,"tenant_id": string
            }[]
                           },
"admin_usage_series":
{ Args: { "p_from"?: string,"p_tenant"?: string,"p_to"?: string }; Returns: {
              "competencia": string,"events": number,"tenant_id": string
            }[]
                           },
"apply_psp_event":
{ Args: { "p_event_id": string }; Returns: Json
                           },
"close_due_invoices":
{ Args: { "p_today": string }; Returns: number
                           },
"complete_first_access":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"create_tenant_for_invited_user":
{ Args: { "p_bairro": string,"p_cep": string,"p_cidade": string,"p_complemento": string,"p_contract_version"?: string,"p_document": string,"p_invited_user_id": string,"p_kind": string,"p_logradouro": string,"p_nome_fantasia": string,"p_numero": string,"p_phone": string,"p_plan_id"?: string,"p_razao_social": string,"p_uf": string }; Returns: string
                           },
"create_tenant_with_owner":
{ Args: { "p_bairro": string,"p_cep": string,"p_cidade": string,"p_complemento": string,"p_document": string,"p_kind": string,"p_logradouro": string,"p_nome_fantasia": string,"p_numero": string,"p_phone": string,"p_plan_id"?: string,"p_razao_social": string,"p_uf": string }; Returns: string
                           },
"create_tenant_with_owner_and_acceptance":
{ Args: { "p_bairro": string,"p_cep": string,"p_cidade": string,"p_complemento": string,"p_contract_version"?: string,"p_document": string,"p_kind": string,"p_logradouro": string,"p_nome_fantasia": string,"p_numero": string,"p_phone": string,"p_plan_id"?: string,"p_razao_social": string,"p_uf": string }; Returns: string
                           },
"drain_psp_events":
{ Args: { "p_event_id"?: string,"p_limit"?: number }; Returns: Json
                           },
"end_impersonation":
{ Args: { "p_token": string }; Returns: boolean
                           },
"expire_subscriptions":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"get_my_subscription":
{ Args: Record<PropertyKey, never>; Returns: {
              "cancel_at_period_end": boolean,"pending_plan_slug": string,"period_end": string,"period_start": string,"plan_slug": string,"status": string,"trial_ends_at": string
            }[]
                           },
"get_plan_limit":
{ Args: { "p_slug": string }; Returns: {
              "max_accounts": number,"max_budgets": number,"max_credit_cards": number,"max_members": number,"max_transactions_month": number
            }[]
                           },
"get_plan_price":
{ Args: { "p_slug": string }; Returns: number
                           },
"get_tenant_usage":
{ Args: { "p_tenant"?: string }; Returns: {
              "limit_max": number,"resource": string,"used": number
            }[]
                           },
"impersonation_read":
{ Args: { "p_params"?: Json,"p_scope": string,"p_tenant": string,"p_token": string }; Returns: Json
                           },
"ingest_psp_event":
{ Args: { "p_event_at"?: string,"p_event_id": string,"p_event_type": string,"p_payload": Json,"p_provider"?: string }; Returns: Json
                           },
"is_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_super_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"list_admin_audit_page":
{ Args: { "p_action"?: string,"p_limit"?: number,"p_offset"?: number,"p_tenant"?: string }; Returns: {
              "action": string,"actor_id": string,"at": string,"from_value": string,"id": string,"reason": string,"target_id": string,"tenant_id": string,"to_value": string
            }[]
                           },
"list_my_invoices":
{ Args: { "p_limit"?: number,"p_offset"?: number }; Returns: Json
                           },
"list_my_tenants":
{ Args: Record<PropertyKey, never>; Returns: {
              "is_active": boolean,"name": string,"role": string,"tenant_id": string
            }[]
                           },
"mark_invoice_paid":
{ Args: { "p_invoice": string }; Returns: number
                           },
"pay_invoice":
{ Args: { "p_account": string,"p_date": string,"p_invoice": string }; Returns: string
                           },
"recalc_invoice_total":
{ Args: { "p_invoice": string }; Returns: number
                           },
"record_mfa_enrolled":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"record_usage_event":
{ Args: { "p_competencia": string,"p_dedup_key": string,"p_occurred_at"?: string,"p_tenant_id": string }; Returns: boolean
                           },
"reopen_invoice":
{ Args: { "p_invoice": string }; Returns: undefined
                           },
"roll_period":
{ Args: { "p_subscription": string }; Returns: Json
                           },
"scrub_psp_events":
{ Args: { "p_limit"?: number }; Returns: Json
                           },
"set_default_account":
{ Args: { "p_account_id": string }; Returns: undefined
                           },
"set_default_card":
{ Args: { "p_card_id": string }; Returns: undefined
                           },
"start_impersonation":
{ Args: { "p_reason": string,"p_tenant": string }; Returns: {
              "expires_at": string,"token": string
            }[]
                           },
"switch_tenant":
{ Args: { "p_tenant": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
