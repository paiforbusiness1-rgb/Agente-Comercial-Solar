// ──────────────────────────────────────────────
// DOMAIN ENTITIES
// ──────────────────────────────────────────────

export type ConversationPhase =
  | 'GREETING'
  | 'QUALIFICATION'
  | 'TECHNICAL_SURVEY'
  | 'QUOTATION'
  | 'FINANCING'
  | 'CLOSING'
  | 'LEAD_GENERATED'
  | 'HUMAN_HANDOFF';

export interface ConversationState {
  phase: ConversationPhase;
  completedSteps: string[];
  missingFields: string[];
  leadScore: number;       // 0–100
  intent?: string;
  clientName?: string;
  monthlyBill?: number;
  bimestralBill?: number;
  billFrequency?: 'bimestral' | 'mensual';
  technicalVisitProposed?: boolean;
  advisorHandoffProposed?: boolean;
  isOwner?: boolean;
  roofType?: string;
  hasShade?: boolean;
  shadows_assessed?: boolean;
  shadowsAssessed?: boolean;
  equivalenceStated?: boolean;
  voltage?: string;
  floors?: number;
  quoteConsentRequested?: boolean;
  quoteConsentGiven?: boolean;
  financingConsentRequested?: boolean;
  financingConsentGiven?: boolean;
  whatsappProfileName?: string;
  mediaSentFlags?: {
    instalacionProfessional?: boolean;
    financiamiento?: boolean;
  };
}

export interface Message {
  sender: 'user' | 'bot' | 'agent';
  text: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  phone: string;
  nombre: string;
  botDisabled: boolean;
  messages: Message[];
  state: ConversationState;
  lastMessageAt: string;
  createdAt: string;
  // Soft Delete fields (Fase 2)
  status?: 'active' | 'deleted';
  deletedAt?: string;
  deletedBy?: string;
  // Legacy lead fields (kept for backward compat with Firestore)
  montoRecibo?: string;
  sistemaEstimado?: string;
  costoEstimado?: string;
}
